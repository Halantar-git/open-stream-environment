//! Живое состояние диагностики: из него собираются `/healthz` и отчёт для
//! поддержки.
//!
//! Порт той части `server/index.js`, что отвечает на вопрос «что происходит»:
//! отчёт о состоянии (`server/health.js`) собирается из уже посчитанных частей,
//! а отчёт для поддержки — из тех же частей плюс файлы на диске. Чтобы роуты
//! остались тонкими, а состояние — одним объектом, и то и другое живёт здесь.
//!
//! Что есть и чего нет. Есть всё, что уже перенесено: настройки, база, журнал
//! команд, замеры задержек и образцы долгого прогона. Нет — того, что придёт с
//! волной 2: клиентов WebSocket, состояния интеграций, текущей сессии стрима и
//! счётчиков доступа из сети. Нули и пустые объекты на их месте — это правда о
//! текущем состоянии порта, а не заглушка: клиентов действительно нет, а
//! интеграции ещё не подключены. Пометка стоит там, где поле появится.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Map, Value};
use tokio::sync::oneshot;

use crate::alerts::{
    AlertQueue, AlertQueueOptions, ChangeFn, EnqueueMeta, EnqueueOutcome, PlayFn, Rules, TimerId,
};
use crate::integrations::chat_bot_control::{store_from_database, ChatBot};
use crate::integrations::donationalerts::{
    GetFn as DonationsGetFn, OAUTH_URL as DA_OAUTH_URL, SUBSCRIBE_URL as DA_SUBSCRIBE_URL,
    USER_URL as DA_USER_URL,
};
use crate::integrations::donationalerts_control::{
    DonationAlertsControl, Oauth, OauthFn, SubscribeFn as DaSubscribeFn,
};
use crate::integrations::longshot_sync::LongshotSync;
use crate::integrations::obs_websocket_control::ObsClient;
use crate::integrations::token_refresh::{TokenRefresher, TokenRefresherConfig};
use crate::integrations::twitch_chat::{ChatRateLimiter, ChatSender, CHAT_SEND_INTERVAL_MS};
use crate::integrations::twitch_chat_control::{EmitFn, SpawnFn, TwitchChatControl};
use crate::integrations::twitch_eventsub::SUBSCRIBE_URL;
use crate::integrations::twitch_eventsub_control::{ConfigFn, StatsFn, TwitchEventsControl};
use crate::integrations::twitch_helix::{TokenFuture, Tokens, TOKEN_URL};
use crate::integrations::youtube_live_control::{
    GetFn, YoutubeConfigFn, YoutubeLiveControl, TOKEN_URL as YOUTUBE_TOKEN_URL,
};
use crate::integrations::{http, token_refresh};
use crate::protocol::event_types;
use crate::server::access::CommandLimiter;
use crate::server::bus::{AccessCounters, ClientRegistry};
use crate::state::runtime::Runtime;
use crate::state::snapshot;
use crate::storage::audit_log::AuditLog;
use crate::storage::config_file::ConfigFile;
use crate::storage::db::Database;
use crate::storage::health::{self, HealthContext, PerfStats};
use crate::storage::history::{js_number_or_zero, js_truthy};
use crate::storage::integrity::RecoveryEvent;
use crate::storage::logger::{LogBus, Logger};
use crate::storage::longrun::{LongRunMonitor, LongRunOptions};
use crate::storage::paths::Storage;
use crate::storage::perf::LagMonitor;
use crate::storage::support_bundle::{self, SupportBundleInput};

/// Имя приложения по умолчанию — как в Electron-версии.
const DEFAULT_APP_NAME: &str = "Open Stream Environment";

/// Сколько последних команд попадает в отчёт для поддержки.
const AUDIT_TAIL: usize = 50;

/// Оболочка окон поверх игры: то, что умеет только главный процесс.
///
/// Сервер (команды и глобальные хоткеи) не создаёт окна сам — он зовёт эти
/// методы, а реализация живёт в `hud.rs` и ставится при старте приложения. Так
/// `server/commands.rs` остаётся без `AppHandle`, как и весь разбор команд.
pub trait HudHost: Send + Sync {
    /// Переключить режим редактирования HUD; вернуть новое состояние.
    fn toggle_hud_edit(&self) -> bool;
    /// Сменить монитор HUD-оверлея (окно пересоздаётся).
    fn hud_display_changed(&self);
    /// Показать/скрыть чат поверх игры.
    fn toggle_chat_hud(&self);
    /// Сменить монитор чата поверх игры.
    fn chat_hud_display_changed(&self);
    /// Обновить геометрию окна чата поверх игры.
    fn chat_hud_config_changed(&self);
    /// Зарегистрировать глобальный хоткей HUD; `false` — не удалось.
    fn register_hud_hotkey(&self, hotkey: &str) -> bool;
    /// Зарегистрировать глобальный хоткей чата поверх игры.
    fn register_chat_hud_hotkey(&self, hotkey: &str) -> bool;
    /// Порт сервера сменился на ходу: окна загружены с прежнего адреса, и их
    /// источник (`Origin`) привязан к старому порту — шина отклонила бы их
    /// переподключение. Реализация переводит окна на новый адрес.
    fn server_port_changed(&self, previous: u16, next: u16);
}

/// Хост сервера: то, что умеет только поднятый слушатель, — смена порта на ходу
/// (порт `switchPort` в `server/index.js`).
///
/// Разбор команд не знает ни о `TcpListener`, ни о фоновой задаче `axum::serve`:
/// он зовёт этот метод, а реализация живёт в `server/mod.rs` и ставится там же,
/// где поднимается сервер. Так `server/commands.rs` остаётся чистым.
pub trait ServerHost: Send + Sync {
    /// Сменить порт на ходу; ответ — `{ ok, port, remoteUrl }`, как у `switchPort`.
    fn switch_port(&self, requested: &Value) -> Value;
}

/// Состояние, из которого собираются оба отчёта.
pub struct Diagnostics {
    storage: Storage,
    app_name: String,
    version: Option<String>,
    /// Момент запуска; от него считается аптайм.
    started_at_ms: i64,
    config: Arc<Mutex<ConfigFile>>,
    database: Arc<Database>,
    audit: AuditLog,
    /// Замеры задержек. Пишет их вызывающий (цикл на tokio), здесь — чтение;
    /// замок нужен, чтобы писатель мог появиться, не меняя тип состояния.
    perf: Mutex<LagMonitor>,
    longrun: LongRunMonitor,
    /// Счётчики рантайма и ход розыгрыша/опроса — живут только в памяти. Под
    /// `Arc`: события шины (статусы связи, камеры) правят их из фоновых задач.
    runtime: Arc<Mutex<Runtime>>,
    /// Подключённые к шине клиенты: по ним считается `byRole`. Под `Arc`, потому
    /// что тот же реестр нужен фоновой задаче чата для рассылки событий.
    clients: Arc<ClientRegistry>,
    /// Ограничитель частоты команд с подменяемыми часами.
    limiter: CommandLimiter,
    /// Отказы доступа за запуск.
    access: AccessCounters,
    /// Случаи порчи за запуск — настройки и база.
    recovery_events: Vec<RecoveryEvent>,
    /// Подключение к чату Twitch: одно за раз, перезапускается настройками.
    twitch_chat: TwitchChatControl,
    /// Отправка в чат и модерация: Helix + обмен токена, сеть настоящая.
    chat_sender: ChatSender,
    /// Чат-бот: движок команд и модерация поверх читателя и `ChatSender`.
    chat_bot: Arc<ChatBot>,
    /// События Twitch (EventSub): follow/sub/cheer и баллы канала.
    twitch_events: TwitchEventsControl,
    /// Донаты DonationAlerts: Centrifugo, OAuth и подписка.
    donation_alerts: DonationAlertsControl,
    /// YouTube Live: поиск эфира и опрос чата.
    youtube: YoutubeLiveControl,
    /// Текущая сессия стрима (или `None`): её время — граница «этого стрима».
    current_session: Arc<Mutex<Option<Value>>>,
    /// OBS WebSocket: подключение и запросы.
    obs: Arc<ObsClient>,
    /// Очередь алертов: одна на приложение, отдаёт алерты по одному.
    alert_queue: Arc<AlertQueue>,
    /// Целевая сцена, куда вернуться после заставки (пока играет видео).
    pending_video: Mutex<Option<Value>>,
    /// Цикл «Колеса Фортуны»: спин, автоспин и автоскрытие (порт таймеров
    /// `createServer` из `index.js`).
    wheel: Arc<WheelCycle>,
    /// Синхронизация Longshot (таймер Executive Hangar): анкер и ленивый опрос.
    longshot: Arc<LongshotSync>,
    /// Идёт ли сейчас добор пропущенных донатов (защита от параллельных вызовов).
    recovering: Arc<AtomicBool>,
    /// Куда уходит журнал служб: в панель (`terminal_log`/`debug_log`).
    log_bus: Arc<dyn LogBus>,
    /// Фактический порт сервера; 0 — ещё не привязан.
    port: AtomicU16,
    /// Адрес пульта; считается при старте и при смене кода доступа.
    remote_url: Mutex<String>,
    /// Режим редактирования HUD: `true` — окно ловит мышь, `false` — сквозной клик.
    hud_edit_mode: AtomicBool,
    /// Оболочка окон поверх игры; ставится один раз при старте приложения.
    hud: OnceLock<Arc<dyn HudHost>>,
    /// Живой слушатель; ставится там же, где сервер поднимается (`server::spawn`).
    server: OnceLock<Arc<dyn ServerHost>>,
    /// Смена сцены по награде канала — полный `SCENE_SET` (маппинг сцен,
    /// заставка). Ставится оболочкой при старте, потому что нужен
    /// `Arc<Diagnostics>`.
    remote_scene: Arc<OnceLock<RemoteSceneFn>>,
    /// Нативное уведомление о событии стрима — как `onStreamAlert` в `main.js`.
    /// Ставится оболочкой: нужно окно приложения и плагин уведомлений.
    notifier: Arc<OnceLock<NotifyFn>>,
}

/// Обработчик смены сцены по событию шины (`reward_scene_request`).
pub type RemoteSceneFn = Arc<dyn Fn(Value) + Send + Sync>;

/// Обработчик нативного уведомления о событии стрима.
pub type NotifyFn = Arc<dyn Fn(&Value) + Send + Sync>;

impl Diagnostics {
    /// Открыть настройки и базу рядом с ними.
    ///
    /// Ошибку возвращаем только тогда, когда недоступен шаблон поставки: без
    /// него не развернуть настройки, и молча стартовать не с чем (см.
    /// `config_file`).
    pub fn open(storage: Storage) -> std::io::Result<Self> {
        let config = ConfigFile::open(&storage)?;
        // Под `Arc`: база нужна и состоянию, и счётчику варнов модерации.
        let database = Arc::new(Database::open(&storage));

        // События порчи собирает вызывающий: у `integrity` нет общего списка.
        let mut recovery_events = Vec::new();
        if let Some(event) = config.recovery_event() {
            recovery_events.push(event.clone());
        }
        if let Some(event) = database.recovery_event() {
            recovery_events.push(event.clone());
        }

        let clients = Arc::new(ClientRegistry::new());
        let log_bus: Arc<dyn LogBus> = Arc::new(ClientLogBus {
            clients: Arc::clone(&clients),
        });
        // Системное хранилище недоступно — секреты лягут на диск открытым
        // текстом. На Windows/Keychain сюда не заходим; на остальных системах
        // скажем один раз, иначе запись секретов в открытом виде была бы молчаливой.
        if let Some(text) = config.secrets().protection_warning() {
            Logger::new("secret-store", Some(Arc::clone(&log_bus))).warn(text, None);
        }
        let initialized = config.value().clone();
        let config = Arc::new(Mutex::new(config));
        let alert_queue = build_alert_queue(Arc::clone(&config), Arc::clone(&clients));
        let chat_sender = build_chat_sender(Arc::clone(&config));
        let chat_bot = {
            let config = Arc::clone(&config);
            let twitch: Arc<dyn Fn() -> Value + Send + Sync> = Arc::new(move || {
                config
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .get("twitch")
                    .cloned()
                    .unwrap_or(Value::Null)
            });
            Arc::new(ChatBot::new(
                chat_sender.clone(),
                spawn_task(),
                Arc::new(|| chrono::Utc::now().timestamp_millis()),
                twitch,
                store_from_database(Arc::clone(&database)),
            ))
        };
        let twitch_events = TwitchEventsControl::new(
            Arc::new(crate::integrations::twitch_chat_socket::websocket_connect),
            build_eventsub_subscribe(Arc::clone(&config), twitch_tokens(Arc::clone(&config))),
            spawn_task(),
        )
        .with_reconnect(Duration::from_millis(
            crate::integrations::twitch_eventsub_control::RECONNECT_DELAY_MS,
        ))
        .with_stats(build_initial_stats(
            Arc::clone(&config),
            twitch_tokens(Arc::clone(&config)),
        ));
        let donation_alerts = {
            let tokens = donation_alerts_tokens(
                Arc::clone(&config),
                configured_port(&initialized).unwrap_or(8710),
            );
            let get_token = Arc::clone(&tokens.ensure);
            DonationAlertsControl::new(
                Arc::new(crate::integrations::twitch_chat_socket::donationalerts_connect),
                build_da_oauth(tokens.clone()),
                build_da_subscribe(tokens),
                get_token,
                spawn_task(),
            )
        };
        let obs = {
            let config = Arc::clone(&config);
            let reader: Arc<dyn Fn() -> Value + Send + Sync> = Arc::new(move || {
                config
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .get("obs")
                    .cloned()
                    .unwrap_or(Value::Null)
            });
            Arc::new(ObsClient::new(
                Arc::new(crate::integrations::twitch_chat_socket::websocket_connect),
                spawn_task(),
                reader,
            ))
        };
        let youtube = {
            let get: GetFn = Arc::new(http::bearer_get_text);
            let tokens = youtube_tokens(Arc::clone(&config));
            let reader: YoutubeConfigFn = {
                let config = Arc::clone(&config);
                Arc::new(move || {
                    config
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .get("youtube")
                        .cloned()
                        .unwrap_or(Value::Null)
                })
            };
            YoutubeLiveControl::new(get, tokens, reader, spawn_task())
        };

        let runtime = Arc::new(Mutex::new(Runtime::new(
            chrono::Utc::now().timestamp_millis(),
            &initialized,
        )));
        let wheel = WheelCycle::new(
            Arc::clone(&runtime),
            Arc::clone(&clients),
            Arc::clone(&log_bus),
        );
        // Longshot: каждый новый снимок кладём в рантайм (оттуда он попадает в
        // `STATE`) и рассылаем кадром `longshot_update` — как `onUpdate` в JS.
        let longshot = {
            let runtime = Arc::clone(&runtime);
            let clients = Arc::clone(&clients);
            Arc::new(
                LongshotSync::new()
                    .with_fetch(Arc::new(http::fetch_json))
                    .with_on_update(Arc::new(move |snapshot: &Value| {
                        let value = {
                            let mut runtime =
                                runtime.lock().unwrap_or_else(|error| error.into_inner());
                            runtime.set_longshot(snapshot)
                        };
                        let frame = json!({
                            "type": event_types::LONGSHOT_UPDATE,
                            "payload": { "longshot": value },
                        })
                        .to_string();
                        clients.broadcast_text(&frame);
                    })),
            )
        };

        Ok(Self {
            storage,
            app_name: DEFAULT_APP_NAME.to_string(),
            version: Some(env!("CARGO_PKG_VERSION").to_string()),
            started_at_ms: chrono::Utc::now().timestamp_millis(),
            runtime,
            config,
            database,
            audit: AuditLog::new(None, None, None),
            perf: Mutex::new(LagMonitor::new("event loop", None)),
            longrun: LongRunMonitor::new(LongRunOptions::default()),
            clients,
            limiter: CommandLimiter::new(None, None, None),
            access: AccessCounters::new(),
            recovery_events,
            twitch_chat: TwitchChatControl::new(
                Arc::new(crate::integrations::twitch_chat_socket::websocket_connect),
                spawn_task(),
            )
            // tmi.js переподключается сам — повторяем это поведение.
            .with_reconnect(Duration::from_millis(
                crate::integrations::twitch_chat_control::RECONNECT_DELAY_MS,
            )),
            chat_sender,
            chat_bot,
            twitch_events,
            donation_alerts,
            youtube,
            current_session: Arc::new(Mutex::new(None)),
            obs,
            alert_queue,
            pending_video: Mutex::new(None),
            wheel,
            longshot,
            recovering: Arc::new(AtomicBool::new(false)),
            log_bus,
            port: AtomicU16::new(0),
            remote_url: Mutex::new(String::new()),
            hud_edit_mode: AtomicBool::new(false),
            hud: OnceLock::new(),
            server: OnceLock::new(),
            remote_scene: Arc::new(OnceLock::new()),
            notifier: Arc::new(OnceLock::new()),
        })
    }

    pub fn storage(&self) -> &Storage {
        &self.storage
    }

    /// Настройки под замком: команды шины их меняют, отчёты читают.
    pub fn config(&self) -> std::sync::MutexGuard<'_, ConfigFile> {
        self.config
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    pub fn database(&self) -> &Database {
        &self.database
    }

    pub fn audit(&self) -> &AuditLog {
        &self.audit
    }

    /// Замеры задержек: их пишет тот, кто ставит таймер.
    pub fn perf(&self) -> &Mutex<LagMonitor> {
        &self.perf
    }

    pub fn longrun(&self) -> &LongRunMonitor {
        &self.longrun
    }

    /// Счётчики рантайма: их правят команды шины, читает снимок.
    pub fn runtime(&self) -> std::sync::MutexGuard<'_, Runtime> {
        self.runtime
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    pub fn clients(&self) -> &ClientRegistry {
        self.clients.as_ref()
    }

    pub fn limiter(&self) -> &CommandLimiter {
        &self.limiter
    }

    pub fn access(&self) -> &AccessCounters {
        &self.access
    }

    /// Реестр клиентов под `Arc` — нужен фоновым задачам для рассылки.
    pub fn clients_arc(&self) -> Arc<ClientRegistry> {
        Arc::clone(&self.clients)
    }

    /// Цикл колеса — общее состояние для команд панели и действий пульта.
    pub fn wheel(&self) -> &Arc<WheelCycle> {
        &self.wheel
    }

    /// Поставить обработчик смены сцены по награде канала (полный `SCENE_SET`).
    pub fn set_remote_scene_handler(&self, handler: RemoteSceneFn) {
        let _ = self.remote_scene.set(handler);
    }

    /// Обработчик смены сцены по награде канала, если оболочка его уже поставила.
    pub fn remote_scene(&self) -> Option<RemoteSceneFn> {
        self.remote_scene.get().cloned()
    }

    /// Поставить обработчик нативных уведомлений о событиях стрима.
    pub fn set_notifier(&self, notifier: NotifyFn) {
        let _ = self.notifier.set(notifier);
    }

    /// Как событие шины доходит до клиентов и до состояния.
    ///
    /// `connection_status` ещё и обновляет службы в рантайме (как
    /// `bus.on("connection_status")` в JS): из этого поля собирается
    /// `integrations` в отчёте, поэтому без него статусы чата и событий жили бы
    /// только в рассылке.
    fn bus_emit(&self) -> EmitFn {
        let clients = Arc::clone(&self.clients);
        let runtime = Arc::clone(&self.runtime);
        Arc::new(move |event: Value| {
            if event["type"].as_str() == Some(event_types::CONNECTION_STATUS) {
                let service = event["payload"]["service"].as_str().unwrap_or("");
                let status = event["payload"]["status"].as_str().unwrap_or("");
                if !service.is_empty() {
                    runtime
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .set_connection_status(service, status);
                }
            }
            clients.broadcast_text(&event.to_string());
        })
    }

    /// Отправка в чат и модерация (клон дешёвый: внутренности под `Arc`).
    pub fn chat_sender(&self) -> ChatSender {
        self.chat_sender.clone()
    }

    /// Настройки Twitch на момент вызова.
    pub fn twitch_config(&self) -> Value {
        self.config().get("twitch").cloned().unwrap_or(Value::Null)
    }

    /// Создать клип Twitch; результат придёт кадром `twitch_action_result`
    /// (`action: "clip"`), как `.then(...)` в JS.
    pub fn create_clip(&self) {
        let post = http::helix_post(Arc::clone(&self.config));
        let tokens = twitch_tokens(Arc::clone(&self.config));
        let twitch = self.twitch_config();
        let clients = Arc::clone(&self.clients);
        std::mem::drop(tauri::async_runtime::spawn(async move {
            let result =
                crate::integrations::twitch_helix::create_clip(&post, &tokens, &twitch).await;
            clients.broadcast_text(&action_frame("clip", result).to_string());
        }));
    }

    /// Поставить маркер стрима; результат — тем же кадром с `action: "marker"`.
    pub fn create_marker(&self, description: &str) {
        let post = http::helix_post(Arc::clone(&self.config));
        let tokens = twitch_tokens(Arc::clone(&self.config));
        let twitch = self.twitch_config();
        let clients = Arc::clone(&self.clients);
        let description = description.to_string();
        std::mem::drop(tauri::async_runtime::spawn(async move {
            let result = crate::integrations::twitch_helix::create_marker(
                &post,
                &tokens,
                &twitch,
                &description,
            )
            .await;
            clients.broadcast_text(&action_frame("marker", result).to_string());
        }));
    }

    /// Подтянуть донаты, пришедшие пока приложение было выключено, — как
    /// `recoverDonations`. Запрос только по кнопке: у DonationAlerts лимит 60
    /// запросов в минуту, а живые донаты приходят сокетом.
    pub fn recover_donations(&self, limit: Option<f64>) {
        if self.recovering.swap(true, Ordering::SeqCst) {
            let frame = json!({
                "type": event_types::ALERT_QUEUE_UPDATE,
                "payload": {
                    "queue": self.queue_snapshot(),
                    "recover": { "ok": false, "error": "in_progress", "count": 0 },
                },
            });
            self.clients.broadcast_text(&frame.to_string());
            return;
        }

        // `Math.max(1, Math.min(100, Number(limit) || 30))`.
        let limit = match limit {
            Some(value) if value != 0.0 => value,
            _ => 30.0,
        }
        .clamp(1.0, 100.0) as i64;

        let get: DonationsGetFn = Arc::new(http::bearer_get_outcome);
        let access_token = self.donation_alerts.access_token();
        let database = Arc::clone(&self.database);
        let emit = self.integration_emit();
        let clients = Arc::clone(&self.clients);
        let queue = Arc::clone(&self.alert_queue);
        let config = Arc::clone(&self.config);
        let recovering = Arc::clone(&self.recovering);
        let log = self.logger("donationalerts");

        log.debug("fetching missed donations", None);
        std::mem::drop(tauri::async_runtime::spawn(async move {
            let token = access_token.await.unwrap_or_default();
            let result =
                crate::integrations::donationalerts::fetch_recent_donations(&get, &token, limit, 1)
                    .await;
            recovering.store(false, Ordering::SeqCst);

            if !js_truthy(result.get("ok")) {
                let error = result.get("error").cloned().unwrap_or(Value::Null);
                log.warn(
                    "missed donations fetch failed",
                    Some(&json!({ "error": error })),
                );
                clients.broadcast_text(&queue_report(
                    &queue,
                    &config,
                    json!({ "ok": false, "error": error }),
                ));
                return;
            }

            // Новым считается донат, id которого нет в истории: id стабилен у
            // сервиса, а время — нет. Показанные сервисом тоже пропускаем.
            let known = database.known_source_ids(None);
            let donations = result
                .get("donations")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let checked = donations.len();
            let missed = missed_donations(&donations, &known);

            // Через шину, а не сразу в очередь: подтянутый донат — настоящий донат,
            // он должен попасть и в историю (с `source_id`), и в цель сбора.
            for donation in &missed {
                emit(json!({
                    "type": event_types::ALERT,
                    "payload": {
                        "kind": "donation",
                        "user": donation.get("user").cloned().unwrap_or(Value::Null),
                        "amount": donation.get("amount").cloned().unwrap_or(Value::Null),
                        "currency": donation.get("currency").cloned().unwrap_or(Value::Null),
                        "message": donation.get("message").cloned().unwrap_or(Value::Null),
                        "sourceId": donation.get("sourceId").cloned().unwrap_or(Value::Null),
                        "recovered": true,
                    },
                }));
            }

            log.success(
                "missed donations fetched",
                Some(&json!({ "count": missed.len(), "checked": checked })),
            );
            clients.broadcast_text(&queue_report(
                &queue,
                &config,
                json!({ "ok": true, "count": missed.len() }),
            ));
        }));
    }

    /// Как событие шины доходит до клиентов и до состояния, а сообщения чата —
    /// ещё и до чат-бота.
    fn chat_emit(&self) -> EmitFn {
        let base = self.bus_emit();
        let bot = Arc::clone(&self.chat_bot);
        let database = Arc::clone(&self.database);
        let session = Arc::clone(&self.current_session);
        let runtime = Arc::clone(&self.runtime);
        let config = Arc::clone(&self.config);
        let clients = Arc::clone(&self.clients);
        Arc::new(move |event: Value| {
            if event["type"].as_str() == Some(event_types::CHAT_MESSAGE) {
                let message = &event["payload"];
                bot.handle_message(message);
                apply_chat_side_effects(message, &database, &session, &runtime, &config, &clients);
            }
            base(event);
        })
    }

    /// Пересобрать чат-бота по текущим настройкам (включение, канал, команды).
    pub fn restart_chat_bot(&self) {
        let (chat_bot, channel, started_at) = {
            let config = self.config();
            (
                config.get("chatBot").cloned().unwrap_or(Value::Null),
                config
                    .get("twitch")
                    .and_then(|twitch| twitch.get("channel"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                self.runtime().started_at(),
            )
        };
        self.chat_bot.restart(&chat_bot, &channel, Some(started_at));
    }

    /// События интеграций: статусы службы — как у чата, остальное — обработчики
    /// шины (`index.js` вешает их на `bus.on`).
    fn integration_emit(&self) -> EmitFn {
        let base = self.bus_emit();
        let ctx = self.bus_context();
        Arc::new(move |event: Value| {
            if event["type"].as_str() == Some(event_types::CONNECTION_STATUS) {
                base(event);
            } else {
                apply_bus_event(&event, &ctx);
            }
        })
    }

    /// То, чем пользуются обработчики шины: настройки, рантайм, очередь, клиенты,
    /// OBS, база и два внешних обработчика (смена сцены, уведомление).
    fn bus_context(&self) -> BusContext {
        BusContext {
            config: Arc::clone(&self.config),
            runtime: Arc::clone(&self.runtime),
            queue: Arc::clone(&self.alert_queue),
            clients: Arc::clone(&self.clients),
            obs: Arc::clone(&self.obs),
            database: Arc::clone(&self.database),
            remote_scene: Arc::clone(&self.remote_scene),
            notifier: Arc::clone(&self.notifier),
        }
    }

    /// Перезапустить EventSub по текущим настройкам — как `restartTwitchEvents`.
    pub fn restart_twitch_events(&self) {
        let (enabled, configured) = {
            let config = self.config();
            let twitch = config.get("twitch");
            let enabled = twitch
                .map(|twitch| js_truthy(twitch.get("enabled")))
                .unwrap_or(false);
            // Без токена и broadcasterId подключаться некуда — как в JS.
            let configured = twitch
                .map(|twitch| {
                    js_truthy(twitch.get("userAccessToken"))
                        && js_truthy(twitch.get("broadcasterId"))
                })
                .unwrap_or(false);
            (enabled, configured)
        };
        let reader: ConfigFn = {
            let config = Arc::clone(&self.config);
            Arc::new(move || {
                Value::Object(
                    config
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .value()
                        .clone(),
                )
            })
        };
        if enabled && !configured {
            // Служба включена, но не настроена: «не настроено», без подключения.
            self.twitch_events.stop();
            let status = json!({
                "type": event_types::CONNECTION_STATUS,
                "payload": { "service": "twitchEvents", "status": "not_configured" },
            });
            (self.integration_emit())(status);
            return;
        }
        self.twitch_events
            .restart(enabled, reader, self.integration_emit());
    }

    /// Перезапустить DonationAlerts по текущим настройкам.
    pub fn restart_donation_alerts(&self) {
        let enabled = {
            let config = self.config();
            config
                .get("donationAlerts")
                .map(|service| js_truthy(service.get("enabled")))
                .unwrap_or(false)
        };
        self.donation_alerts
            .restart(enabled, self.integration_emit());
    }

    /// Перезапустить OBS по текущим настройкам.
    pub fn restart_obs(&self) {
        let enabled = {
            let config = self.config();
            config
                .get("obs")
                .map(|obs| js_truthy(obs.get("enabled")))
                .unwrap_or(false)
        };
        self.obs.restart(enabled, self.integration_emit());
    }

    /// Перезапустить YouTube Live по текущим настройкам.
    pub fn restart_youtube(&self) {
        let enabled = {
            let config = self.config();
            config
                .get("youtube")
                .map(|service| js_truthy(service.get("enabled")))
                .unwrap_or(false)
        };
        self.youtube.restart(enabled, self.youtube_emit());
    }

    /// Сохранить токены Twitch и перезапустить EventSub — хвост возврата из
    /// авторизации, как `hooks.onTwitchConnected` в JS.
    ///
    /// Замок настроек берём на время записи и отпускаем до перезапуска: он
    /// читает настройки сам, а `Mutex` здесь не реентерабельный.
    pub fn save_twitch_tokens_and_restart(&self, patch: &Value) {
        {
            let mut config = self.config();
            crate::state::config::save_twitch_tokens(&mut config, patch);
        }
        self.restart_twitch_events();
    }

    /// Сохранить токены DonationAlerts и перезапустить службу.
    pub fn save_donation_alerts_tokens_and_restart(&self, patch: &Value) {
        {
            let mut config = self.config();
            crate::state::config::save_donation_alerts_tokens(&mut config, patch);
        }
        self.restart_donation_alerts();
    }

    /// Сохранить токены YouTube и перезапустить службу.
    pub fn save_youtube_tokens_and_restart(&self, patch: &Value) {
        {
            let mut config = self.config();
            crate::state::config::save_youtube_tokens(&mut config, patch);
        }
        self.restart_youtube();
    }

    // ---- Longshot (таймер Executive Hangar) ----

    /// Есть ли в раскладке видимый таймер Executive Hangar (роль «timer»: и 2D
    /// `timer`, и 3D `grimhex-timer`).
    pub fn has_timer_widget(&self) -> bool {
        self.database.widgets().iter().any(|widget| {
            if widget.get("visible") == Some(&Value::Bool(false)) {
                return false;
            }
            let kind = widget
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            crate::catalog::widget_role(kind).as_deref() == Some("timer")
        })
    }

    /// Ленивый опрос Longshot: включаем, только пока в раскладке есть видимый
    /// таймер, и при включении сразу тянем свежий анкер — как `syncLongshotActivity`.
    pub fn sync_longshot_activity(&self) {
        let want = self.has_timer_widget();
        let was = self.longshot.is_active();
        self.longshot.set_active(want);
        if want && !was {
            self.refresh_longshot();
        }
    }

    /// Сходить за конфигом Longshot — кнопка «Обновить» (`cmd_refresh_longshot`).
    pub fn refresh_longshot(&self) {
        let longshot = Arc::clone(&self.longshot);
        std::mem::drop(tauri::async_runtime::spawn(async move {
            longshot.refresh().await;
        }));
    }

    /// Запустить фоновый опрос Longshot: раз в интервал, только пока он активен.
    pub fn start_longshot_poll(&self) {
        let longshot = Arc::clone(&self.longshot);
        let interval_ms = longshot.interval_ms().max(1) as u64;
        std::mem::drop(tauri::async_runtime::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_millis(interval_ms));
            loop {
                ticker.tick().await;
                if longshot.is_active() {
                    longshot.refresh().await;
                }
            }
        }));
    }

    // ---- Окна поверх игры ----

    /// Поставить оболочку окон поверх игры — один раз при старте приложения.
    pub fn install_hud(&self, host: Arc<dyn HudHost>) {
        let _ = self.hud.set(host);
    }

    fn hud_host(&self) -> Option<Arc<dyn HudHost>> {
        self.hud.get().cloned()
    }

    /// Поставить хост сервера — там же, где поднимается слушатель, один раз.
    pub fn install_server(&self, host: Arc<dyn ServerHost>) {
        let _ = self.server.set(host);
    }

    /// Хост сервера, если он уже поднят.
    pub fn server_host(&self) -> Option<Arc<dyn ServerHost>> {
        self.server.get().cloned()
    }

    /// Сообщить оболочке, что сервер переехал на другой порт: окна надо
    /// перевести на новый адрес, иначе шина отклонит их переподключение.
    pub fn server_port_changed(&self, previous: u16, next: u16) {
        if let Some(host) = self.hud_host() {
            host.server_port_changed(previous, next);
        }
    }

    /// Разослать кадр `{ type, payload }` всем клиентам.
    pub fn broadcast(&self, kind: &str, payload: Value) {
        let text = json!({ "type": kind, "payload": payload }).to_string();
        self.clients.broadcast_text(&text);
    }

    /// Переключить режим редактирования HUD — сюда смотрит и команда панели, и
    /// глобальный хоткей.
    pub fn toggle_hud_edit_mode(&self) {
        if let Some(host) = self.hud_host() {
            let enabled = host.toggle_hud_edit();
            self.set_hud_edit_mode(enabled);
        }
    }

    /// Запомнить режим редактирования и сообщить клиентам — как `setHudEditMode`.
    pub fn set_hud_edit_mode(&self, enabled: bool) -> bool {
        self.hud_edit_mode.store(enabled, Ordering::SeqCst);
        self.broadcast(event_types::HUD_EDIT_MODE, json!({ "enabled": enabled }));
        enabled
    }

    /// Текущий режим редактирования HUD.
    pub fn hud_edit_mode(&self) -> bool {
        self.hud_edit_mode.load(Ordering::SeqCst)
    }

    /// Окно HUD пересоздаётся на другом мониторе.
    pub fn hud_display_changed(&self) {
        if let Some(host) = self.hud_host() {
            host.hud_display_changed();
        }
    }

    /// Показать/скрыть чат поверх игры.
    pub fn toggle_chat_hud(&self) {
        if let Some(host) = self.hud_host() {
            host.toggle_chat_hud();
        }
    }

    /// Окно чата поверх игры пересоздаётся на другом мониторе.
    pub fn chat_hud_display_changed(&self) {
        if let Some(host) = self.hud_host() {
            host.chat_hud_display_changed();
        }
    }

    /// Геометрия окна чата поверх игры изменилась.
    pub fn chat_hud_config_changed(&self) {
        if let Some(host) = self.hud_host() {
            host.chat_hud_config_changed();
        }
    }

    /// Зарегистрировать хоткей HUD. Без оболочки — `true`: в JS отсутствие
    /// `onSetHudHotkey` тоже означает «пропустить и сохранить».
    pub fn register_hud_hotkey(&self, hotkey: &str) -> bool {
        match self.hud_host() {
            Some(host) => host.register_hud_hotkey(hotkey),
            None => true,
        }
    }

    /// Зарегистрировать хоткей чата поверх игры.
    pub fn register_chat_hud_hotkey(&self, hotkey: &str) -> bool {
        match self.hud_host() {
            Some(host) => host.register_chat_hud_hotkey(hotkey),
            None => true,
        }
    }

    /// События YouTube: статус — как у остальных служб, сообщения чата — ещё и
    /// чат-боту (не-Twitch он отсеивает сам), алерты — обработчикам шины.
    fn youtube_emit(&self) -> EmitFn {
        let base = self.chat_emit();
        let ctx = self.bus_context();
        Arc::new(move |event: Value| {
            let kind = event["type"].as_str().unwrap_or("");
            if kind == event_types::CHAT_MESSAGE || kind == event_types::CONNECTION_STATUS {
                base(event);
            } else {
                apply_bus_event(&event, &ctx);
            }
        })
    }

    /// Клиент OBS — команды камер и сцены идут через него.
    pub fn obs(&self) -> Arc<ObsClient> {
        Arc::clone(&self.obs)
    }

    /// Запустить звук саундборда (кнопка панели и внешние триггеры): ищем звук в
    /// настройках и рассылаем `soundboard_play`, как `triggerSoundboardSound`.
    pub fn trigger_soundboard(&self, sound_id: &str, user: &str) -> bool {
        let payload = {
            let config = self.config();
            soundboard_payload(&config, sound_id, user)
        };
        let Some(payload) = payload else {
            return false;
        };
        broadcast_clients(&self.clients, event_types::SOUNDBOARD_PLAY, payload);
        true
    }

    /// Перезапустить чтение чата Twitch по текущим настройкам.
    ///
    /// Зовётся при старте приложения, при смене канала и по кнопке
    /// «переподключить» — как `restartTwitchChat` в JS. Пустой канал даёт
    /// `not_configured`, выключенный сервис — `disabled`; события уходят в шину.
    pub fn restart_twitch_chat(&self) {
        let (enabled, channel) = {
            let config = self.config();
            let twitch = config.get("twitch");
            (
                twitch
                    .map(|twitch| js_truthy(twitch.get("enabled")))
                    .unwrap_or(false),
                twitch
                    .and_then(|twitch| twitch.get("channel"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            )
        };
        self.twitch_chat
            .restart(enabled, &channel, self.chat_emit());
    }

    /// Очередь алертов — команды панели и пульта правят её напрямую.
    pub fn alert_queue(&self) -> &AlertQueue {
        &self.alert_queue
    }

    /// Включена ли очередь алертов (поле из настроек).
    pub fn queue_enabled(&self) -> bool {
        let config = self.config();
        crate::state::config::alert_queue_config(&config)["enabled"] != Value::Bool(false)
    }

    /// Снимок очереди в форме, которую ждёт панель: снимок плюс `enabled`.
    pub fn queue_snapshot(&self) -> Value {
        let mut snapshot = self.alert_queue.snapshot();
        let enabled = self.queue_enabled();
        if let Value::Object(map) = &mut snapshot {
            map.insert("enabled".to_string(), Value::Bool(enabled));
        }
        snapshot
    }

    /// Правила очереди из текущих настроек.
    pub fn queue_rules(&self) -> Rules {
        let config = self.config();
        rules_from(&config)
    }

    /// Опубликовать алерт: при выключенной очереди — сразу в шину, иначе в
    /// очередь (как `publishAlert` в JS).
    pub fn publish_alert(&self, alert: &Value, meta: &EnqueueMeta) -> EnqueueOutcome {
        if !self.queue_enabled() {
            let text = json!({ "type": event_types::ALERT, "payload": alert }).to_string();
            self.clients.broadcast_text(&text);
            return EnqueueOutcome {
                accepted: true,
                reason: None,
                merged: false,
                item: None,
            };
        }
        self.alert_queue.enqueue(alert, meta)
    }

    /// Алерт колеса — напрямую, минуя очередь (см. `bus.on("alert")` в `index.js`):
    /// его показ привязан к сцене розыгрыша, которую прячет таймер колеса, и
    /// карточка победителя не должна ждать чужих донатов. `durationMs` берётся из
    /// словаря, если не задан явно (у выбывания — 3000).
    pub fn broadcast_wheel_alert(&self, alert: &Value) {
        let kind = alert.get("kind").and_then(Value::as_str).unwrap_or("");
        let mut payload = alert.clone();
        if let Value::Object(map) = &mut payload {
            let default = json!(crate::protocol::alert_duration_ms(kind).unwrap_or(5000));
            map.entry("durationMs".to_string()).or_insert(default);
        }
        self.broadcast(event_types::ALERT, payload);
    }

    /// Повторить событие из истории — как `replayEvent` в JS: запись берётся по
    /// `id`, а алерт идёт без фильтра по сумме, в начало очереди и даже на паузе.
    /// Возвращает саму запись (или `null`, если такой нет).
    pub fn replay_event(&self, id: &Value) -> Value {
        let Some(record) = self.database.stream_event_by_id(Some(id)) else {
            return Value::Null;
        };
        let kind = record
            .get("kind")
            .filter(|value| js_truthy(Some(value)))
            .or_else(|| record.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let mut alert = json!({
            "kind": record.get("kind").cloned().or_else(|| record.get("type").cloned()).unwrap_or(Value::Null),
            "user": record.get("username").cloned().unwrap_or(Value::Null),
            "amount": record.get("amount").cloned().unwrap_or(Value::Null),
            "currency": record.get("currency").cloned().unwrap_or(Value::Null),
            "message": record.get("message").cloned().unwrap_or(Value::Null),
            "count": record.get("count").cloned().unwrap_or(Value::Null),
            "tier": record.get("tier").cloned().unwrap_or(Value::Null),
        });
        let duration = crate::protocol::alert_duration_ms(kind).unwrap_or(5000);
        if let Value::Object(map) = &mut alert {
            map.entry("durationMs".to_string())
                .or_insert(Value::from(duration));
        }
        // Ручной повтор: человек нажал кнопку и хочет видеть этот алерт, а не тот,
        // что сейчас в эфире, — поэтому мимо фильтра, в начало и на паузе.
        self.publish_alert(
            &alert,
            &EnqueueMeta {
                force: true,
                ignore_pause: true,
                recovered: false,
                front: true,
            },
        );
        record
    }

    /// Полный сброс базы — как `db.clearAll()` в JS. Приложение после него
    /// перезапускается: рабочая копия раскладки живёт в памяти и без рестарта
    /// вернулась бы в базу при первой же мутации.
    pub fn reset_database(&self) {
        self.database.clear_all();
        self.database.flush_sync();
    }

    /// Восстановить паузу очереди из настроек при старте — `restorePause` в JS.
    pub fn restore_alert_pause(&self) {
        let paused_until = {
            let config = self.config();
            js_number_or_zero(crate::state::config::alert_queue_config(&config).get("pause_until"))
        };
        self.alert_queue.restore_pause(paused_until);
    }

    /// Привести настройки к текущей форме и записать — как конструктор `state.js`,
    /// который нормализует конфиг с диска. Зовётся при запуске приложения.
    pub fn normalize(&mut self) {
        let mut config = self
            .config
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        crate::state::config::normalize_config(&mut config);
        // Код доступа из сети: чужой (правленый руками) считаем отсутствующим и
        // выдаём новый — как `normalizeRemoteToken` в конструкторе `state.js`.
        let normalized = crate::server::access::normalize_remote_token(config.get("remote_token"));
        let token = if normalized.is_empty() {
            crate::server::access::generate_remote_token()
        } else {
            normalized
        };
        config.set("remote_token", Value::from(token));
        // Старую раскладку из настроек переносим в базу один раз — как
        // `_loadLayoutFromDb` + `delete this.config.layout` в конструкторе `state.js`.
        // Иначе `has_timer_widget` и первая команда раскладки читали бы пустую базу
        // до первого `widgets()`, а ключ навсегда остался бы в `config.json`.
        if config.get("layout").is_some() {
            let migrated = crate::state::layout::widgets(&self.database, &config);
            if !migrated.is_empty() {
                self.database.save_widgets(migrated);
            }
            config.remove("layout");
        }
        config.save();
    }

    /// Запомнить фактический порт сервера (после привязки) и адрес пульта.
    pub fn set_port(&self, port: u16) {
        self.port.store(port, Ordering::SeqCst);
        self.refresh_remote_url();
    }

    /// Фактический порт слушателя; пока он не привязан — порт из настроек.
    ///
    /// Единый источник порта: его читают роуты (`/healthz`, OAuth-возврат,
    /// проверка источника) и оболочка окон, чтобы после смены порта на ходу не
    /// осталось ни одной копии старого значения.
    pub fn port(&self) -> u16 {
        self.effective_port()
    }

    /// Адрес пульта для доступа из локальной сети — как `buildRemoteUrl` в JS.
    pub fn remote_url(&self) -> String {
        let cached = self
            .remote_url
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        if !cached.is_empty() {
            return cached;
        }
        let url = self.build_remote_url();
        *self
            .remote_url
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = url.clone();
        url
    }

    /// Новый код доступа: старый перестаёт действовать, внешние клиенты
    /// отключаются, а панель получает свежий адрес пульта — как
    /// `rotateRemoteToken` в JS.
    pub fn rotate_access_code(&self) -> Value {
        let token = crate::server::access::generate_remote_token();
        {
            let mut config = self.config();
            config.set("remote_token", Value::from(token));
            config.save();
        }
        self.refresh_remote_url();
        self.clients.remove_external();
        self.logger("server")
            .warn("remote access code rotated", None);
        self.broadcast_state();
        json!({ "ok": true, "remoteUrl": self.remote_url() })
    }

    /// Разослать снимок состояния всем клиентам.
    pub fn broadcast_state(&self) {
        let frame =
            json!({ "type": event_types::STATE, "payload": self.state_snapshot() }).to_string();
        self.clients.broadcast_text(&frame);
    }

    /// Импортировать настройки из чужого файла — как `importConfig` в JS:
    /// известные разделы заменяются, свои ключи остаются.
    pub fn import_config(&self, patch: &Value) {
        {
            let mut config = self.config();
            // Чужой файл может не подойти — свои ключи всё равно остаются.
            let _ = crate::state::config::replace_config(&mut config, &self.database, patch);
        }
        // Новые настройки — новые подключения: иначе службы работали бы со
        // старыми ключами и каналом (как `importConfig` в JS).
        self.restart_twitch_chat();
        self.restart_chat_bot();
        self.restart_twitch_events();
        self.restart_donation_alerts();
        self.restart_youtube();
        // Импорт мог принести раскладку с таймером (или убрать его).
        self.sync_longshot_activity();
        self.broadcast_state();
    }

    /// Слоты резервных копий настроек — для списка «Резервные копии».
    pub fn list_config_backups(&self) -> Vec<Value> {
        let config = self.config();
        crate::storage::integrity::describe_backups(
            config.path(),
            crate::storage::atomic::DEFAULT_BACKUP_SLOTS,
        )
        .into_iter()
        .map(|slot| {
            json!({
                "slot": slot.slot,
                "file": slot.file.to_string_lossy(),
                "name": slot.name,
                "bytes": slot.bytes,
                "mtime": slot.mtime_ms,
                "valid": slot.valid,
                "error": slot.error,
            })
        })
        .collect()
    }

    /// Откатить настройки или базу к резервной копии — команда `backup:restore`.
    ///
    /// База возвращает раскладку/пресеты/сессии из снапшота (история событий и
    /// чата живёт отдельно и не трогается), а настройки проходят через тот же
    /// путь, что импорт: известные разделы заменяются, свои ключи и код доступа
    /// остаются, интеграции переподключаются по новым настройкам.
    pub fn restore_backup(&self, target: &str, slot: usize) -> Value {
        match target {
            "config" => {
                let candidate = {
                    let config = self.config();
                    crate::storage::atomic::backup_path(config.path(), slot)
                };
                match crate::storage::integrity::try_read_json(&candidate) {
                    crate::storage::integrity::JsonRead::Value(mut value) => {
                        // В копии секреты лежат зашифрованными (как и в
                        // config.json), поэтому сначала расшифровываем — иначе на
                        // следующей записи они зашифровались бы второй раз (как
                        // `decryptConfig` в `restoreConfigFromBackup`).
                        {
                            let config = self.config();
                            if let Some(object) = value.as_object_mut() {
                                crate::storage::config_file::open_secrets(object, config.secrets());
                            }
                        }
                        self.import_config(&value);
                        self.logger("server").warn(
                            "config restored from backup",
                            Some(&json!({ "slot": slot })),
                        );
                        json!({ "ok": true, "slot": slot, "target": "config" })
                    }
                    crate::storage::integrity::JsonRead::Missing => {
                        json!({ "ok": false, "error": "резервная копия недоступна" })
                    }
                    crate::storage::integrity::JsonRead::Invalid(error) => {
                        json!({ "ok": false, "error": error })
                    }
                }
            }
            "database" => {
                let result = self.database.restore_from_backup(slot);
                if result["ok"] == Value::Bool(true) {
                    self.logger("server").warn(
                        "database restored from backup",
                        Some(&json!({ "slot": slot })),
                    );
                    // Раскладку и тему панель перерисует по свежим кадрам.
                    self.broadcast(
                        event_types::THEME_UPDATE,
                        self.state_snapshot()["appearance"].clone(),
                    );
                    self.broadcast_state();
                }
                result
            }
            _ => json!({ "ok": false, "error": "неизвестная цель восстановления" }),
        }
    }

    fn refresh_remote_url(&self) {
        let url = self.build_remote_url();
        *self
            .remote_url
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = url;
    }

    fn build_remote_url(&self) -> String {
        format!(
            "http://{}:{}/remote?token={}",
            local_ip(),
            self.effective_port(),
            self.remote_token()
        )
    }

    fn effective_port(&self) -> u16 {
        let port = self.port.load(Ordering::SeqCst);
        if port == 0 {
            self.configured_port().unwrap_or(8710)
        } else {
            port
        }
    }

    /// Открыть сессию стрима при старте — как `startIntegrations`: события
    /// привязываются ко времени сессии, а счёт донатов начинается заново.
    pub fn start_stream_session(&self) {
        if self.session_lock().is_some() {
            return;
        }
        let channel = {
            let config = self.config();
            config
                .get("twitch")
                .and_then(|twitch| twitch.get("channel"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        let session = self.database.start_session(&channel);
        *self.session_lock() = Some(session);
        self.runtime().reset_session_donations();
    }

    /// Закрыть сессию стрима (при выходе приложения).
    pub fn end_stream_session(&self) {
        let session = self.session_lock().take();
        if let Some(session) = session {
            self.database
                .end_session(session.get("id").unwrap_or(&Value::Null));
        }
    }

    /// Начало текущей сессии в миллисекундах; 0 — сессии ещё нет.
    fn session_started_at(&self) -> i64 {
        self.session_lock()
            .as_ref()
            .and_then(|session| session.get("startedAt"))
            .map(|value| js_number_or_zero(Some(value)) as i64)
            .unwrap_or(0)
    }

    fn current_session_value(&self) -> Option<Value> {
        self.session_lock().clone()
    }

    fn session_lock(&self) -> std::sync::MutexGuard<'_, Option<Value>> {
        self.current_session
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    /// Журнал службы: записи уходят в консоль, в панель (`terminal_log`/
    /// `debug_log`) и в суточный файл (если включено файловое логирование).
    pub fn logger(&self, service: &str) -> Logger {
        Logger::new(service, Some(Arc::clone(&self.log_bus)))
    }

    /// Язык интерфейса из базы.
    pub fn language(&self) -> &'static str {
        self.database.language()
    }

    pub fn save_language(&self, language: &str) -> &'static str {
        self.database.save_language(language)
    }

    /// Выполнить свою команду OBS по id — как `runObsCommand` в JS.
    ///
    /// Команда берётся из настроек (`obs.customCommands`), запрос уходит в OBS
    /// WebSocket; ответ не ждём — ошибку пишем в журнал.
    pub fn run_obs_command(&self, id: Value) -> bool {
        let id = id.as_str().unwrap_or_default().to_string();
        let command = {
            let config = self.config();
            config
                .get("obs")
                .and_then(|obs| obs.get("customCommands"))
                .and_then(Value::as_array)
                .and_then(|list| {
                    list.iter()
                        .find(|cmd| cmd.get("id").and_then(Value::as_str) == Some(id.as_str()))
                        .cloned()
                })
        };
        let Some(command) = command else {
            self.logger("server").warn(
                "OBS command skipped (unknown command)",
                Some(&json!({ "id": id })),
            );
            return false;
        };
        let request_type = command
            .get("requestType")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        if request_type.is_empty() {
            self.logger("server").warn(
                "OBS command skipped (empty requestType)",
                Some(&json!({ "id": id })),
            );
            return false;
        }
        let obs = self.obs();
        if !obs.is_connected() {
            self.logger("server").warn(
                "OBS command skipped (OBS not connected)",
                Some(&json!({ "id": id })),
            );
            return false;
        }
        let request_data = command
            .get("requestData")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let logger = self.logger("server");
        std::mem::drop(tauri::async_runtime::spawn(async move {
            if let Err(message) = obs.request(&request_type, &request_data).await {
                logger.warn(
                    "OBS raw command failed",
                    Some(&json!({ "id": id, "requestType": request_type, "message": message })),
                );
            }
        }));
        true
    }

    /// Запомнить цель перехода после заставки (`None` — перехода нет).
    pub fn set_pending_video(&self, target: Option<Value>) {
        *self
            .pending_video
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = target;
    }

    /// Текущая цель перехода после заставки.
    pub fn pending_video(&self) -> Option<Value> {
        self.pending_video
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    /// Забрать цель перехода: после конца заставки она больше не нужна.
    pub fn take_pending_video(&self) -> Option<Value> {
        self.pending_video
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
    }

    /// Провести событие по шине, как `bus.emit(...)` в JS: алерт, звук, камера,
    /// озвучка награды — всё уходит в те же обработчики.
    pub fn emit_bus(&self, event: Value) {
        (self.integration_emit())(event);
    }

    /// Прогнать действия правила награды канала — тестовая кнопка у правила
    /// (`cmd_test_twitch_reward`), как `triggerRewardActions` в JS.
    ///
    /// `false` — правила с таким `id` нет; причина уходит в журнал.
    pub fn test_twitch_reward(&self, id: &str) -> bool {
        let rule = {
            let config = self.config();
            let rewards = config.get("twitchRewards").cloned().unwrap_or(Value::Null);
            rewards.as_array().and_then(|list| {
                list.iter()
                    .find(|rule| rule.get("id").and_then(Value::as_str) == Some(id))
                    .cloned()
            })
        };
        let Some(rule) = rule else {
            self.logger("server").warn(
                "reward test skipped (unknown rule)",
                Some(&json!({ "id": id })),
            );
            return false;
        };
        let reward_id = rule.get("rewardId").cloned().unwrap_or(Value::Null);
        let reward_title = rule.get("rewardTitle").cloned().unwrap_or(Value::Null);
        self.run_reward_actions(&reward_id, &reward_title, "Тест", "")
    }

    /// Прогнать действия правила награды: алерт, озвучка, сцена.
    ///
    /// `true` — правило нашлось (как `triggerRewardActions` в JS), даже если у
    /// него нет ни одного действия.
    pub fn run_reward_actions(
        &self,
        reward_id: &Value,
        reward_title: &Value,
        user: &str,
        user_input: &str,
    ) -> bool {
        let config_value = {
            let config = self.config();
            Value::Object(config.value().clone())
        };
        let rewards = config_value
            .get("twitchRewards")
            .cloned()
            .unwrap_or(Value::Null);
        if crate::integrations::twitch_eventsub::find_reward_rule(&rewards, reward_id, reward_title)
            .is_none()
        {
            return false;
        }
        for event in crate::integrations::twitch_eventsub::reward_actions(
            &config_value,
            reward_id,
            reward_title,
            user,
            user_input,
        ) {
            self.emit_bus(event);
        }
        true
    }

    /// Код доступа из сети (пустой, если не задан).
    pub fn remote_token(&self) -> String {
        self.config()
            .get("remote_token")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    }

    /// Снимок состояния для клиентов шины.
    pub fn state_snapshot(&self) -> Value {
        // Замки настроек и рантайма берём на время сборки и отпускаем до
        // очереди: она читает настройки сама, а `Mutex` здесь не реентерабельный.
        let session_started_at = self.session_started_at();
        let mut snapshot = {
            let config = self.config();
            let runtime = self.runtime();
            snapshot::snapshot(&config, &self.database, &runtime)
        };
        if let Value::Object(map) = &mut snapshot {
            // Адрес пульта — рядом с кодом доступа: панель показывает его целиком.
            map.insert("remoteUrl".to_string(), Value::from(self.remote_url()));
            map.insert("alertQueue".to_string(), self.queue_snapshot());
            // Начало текущей сессии — граница «только этот стрим» (0 — нет сессии).
            map.insert(
                "sessionStartedAt".to_string(),
                Value::from(session_started_at),
            );
            // Режим редактирования HUD — не настройка, а живое состояние рантайма.
            map.insert("hudEditMode".to_string(), Value::Bool(self.hud_edit_mode()));
        }
        snapshot
    }

    pub fn recovery_events(&self) -> &[RecoveryEvent] {
        &self.recovery_events
    }

    /// Замечания о нечитаемых секретах — для стартового диалога (как
    /// `getSecretIssues` в `main.js`). Самих секретов в них нет, только метки.
    pub fn secret_issues(&self) -> Vec<crate::storage::secrets::IssueNote> {
        self.config().secrets().issues()
    }

    /// Забыть замечания после того, как пользователь их увидел.
    pub fn clear_secret_issues(&self) {
        self.config().secrets().clear_issues();
    }

    /// Порт из настроек; `None` — мусор или поля нет, умолчание решает вызывающий.
    pub fn configured_port(&self) -> Option<u16> {
        configured_port(self.config().value())
    }

    /// Короткий отчёт о состоянии — то, что отдаёт `/healthz`.
    pub fn health_report(&self, port: u16, listening: bool) -> Value {
        health::build_health_report(&self.health_context(port, listening))
    }

    /// Полный отчёт для поддержки как документ.
    pub fn support_bundle(&self, port: u16, listening: bool) -> Value {
        // Настройки берём под замком один раз: два `self.config()` в одном
        // выражении заклинили бы поток на нереентерабельном `Mutex`.
        let (config, config_path) = {
            let config = self.config();
            (Value::Object(config.value().clone()), config.path().clone())
        };
        support_bundle::build_support_bundle(&SupportBundleInput {
            app_name: Some(self.app_name.clone()),
            version: self.version.clone(),
            config_dir: Some(self.storage.config_dir().to_path_buf()),
            logs_dir: Some(self.storage.logs_dir()),
            // Адрес пульта в отчёте нужен (как `remoteUrl` в JS): по нему видно,
            // на каком адресе ждут пульт. Код доступа в нём замаскирует
            // `sanitize`, а настройки к этому моменту уже скопированы —
            // повторный захват замка безопасен.
            remote_url: Some(self.remote_url()),
            config,
            layout: Value::Array(self.database.widgets()),
            health: self.health_context(port, listening),
            audit: self.audit.recent(Some(AUDIT_TAIL)),
            longrun: Some(self.longrun.snapshot()),
            recovery_events: self.recovery_events.clone(),
            // Бэкапы смотрим у обоих файлов состояния — по ним видно, к чему
            // пользователь может откатиться.
            backup_sources: vec![config_path, self.database.path().to_path_buf()],
            ..Default::default()
        })
    }

    /// Тот же отчёт текстом — то, что отдаёт `/support-bundle` и диалог сохранения.
    pub fn support_bundle_text(&self, port: u16, listening: bool) -> String {
        support_bundle::render_support_bundle(&self.support_bundle(port, listening))
    }

    /// Всё, что нужно обоим отчётам: собирается в одном месте, чтобы `/healthz` и
    /// отчёт для поддержки не разъехались.
    fn health_context(&self, port: u16, listening: bool) -> HealthContext {
        let perf = self
            .perf
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .snapshot();
        let runtime = self.runtime();
        let (clients, by_role) = self.clients.counts();
        let mut security = self.access.snapshot();
        if let Some(object) = security.as_object_mut() {
            object.insert("audit".to_string(), self.audit.counters());
        }

        HealthContext {
            app_name: Some(self.app_name.clone()),
            version: self.version.clone(),
            mode: Some("tauri".to_string()),
            // `max(0)` на случай перевода часов назад считает `health`.
            uptime_sec: Some(
                (chrono::Utc::now().timestamp_millis() - self.started_at_ms) as f64 / 1000.0,
            ),
            port: Some(port),
            listening: Some(listening),
            ws_clients: Some(clients as u64),
            ws_by_role: Some(by_role),
            // Сессия стрима: её начало — граница «этого стрима» в отчёте.
            session: self.current_session_value().map(|session| {
                json!({
                    "id": session.get("id").cloned().unwrap_or(Value::Null),
                    "channel": session.get("channel").cloned().unwrap_or(Value::Null),
                    "startedAt": session.get("startedAt").cloned().unwrap_or(Value::Null),
                })
            }),
            integrations: Some(
                runtime
                    .connection_status()
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
            ),
            storage: Some(self.database.storage_stats()),
            writes: Some(self.database.write_stats()),
            perf: Some(PerfStats::from(perf)),
            longrun: Some(self.longrun.snapshot()),
            security: Some(security),
        }
    }
}

/// Порт из настроек.
///
/// Правило то же, что у `readPort`: числом считается только число — строка
/// `"1234"` и значение вне `u16` портом не являются.
pub fn configured_port(config: &Map<String, Value>) -> Option<u16> {
    u16::try_from(config.get("port")?.as_u64()?).ok()
}

/// Локальный адрес в сети для адреса пульта.
///
/// В JS интерфейсы перебираются (`os.networkInterfaces`) с приоритетом
/// физических и приватных; здесь берём адрес маршрута по умолчанию — его
/// достаточно, чтобы телефон в той же сети открыл пульт, — а если маршрута нет,
/// остаётся `127.0.0.1`.
fn local_ip() -> String {
    use std::net::UdpSocket;
    // Ничего не отправляется: `connect` на UDP только выбирает маршрут и адрес.
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(address) = socket.local_addr() {
                let ip = address.ip();
                if !ip.is_loopback() {
                    return ip.to_string();
                }
            }
        }
    }
    "127.0.0.1".to_string()
}

/// Запустить фоновую задачу в рантайме Tauri — тот же способ, что у сервера.
/// `JoinHandle` не нужен: остановкой управляет [`TwitchChatControl`].
fn spawn_task() -> SpawnFn {
    Arc::new(|task| {
        std::mem::drop(tauri::async_runtime::spawn(task));
    })
}

/// Обновлятель токенов Twitch: один на интеграцию, как `createTokenRefresher` в JS.
fn twitch_tokens(config: Arc<Mutex<ConfigFile>>) -> Tokens {
    let get_config = {
        let config = Arc::clone(&config);
        Arc::new(move || {
            config
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .get("twitch")
                .cloned()
                .unwrap_or(Value::Null)
        })
    };
    let save_tokens = {
        let config = Arc::clone(&config);
        Arc::new(move |body: &Value, expires_at: i64| {
            let mut config = config.lock().unwrap_or_else(|error| error.into_inner());
            let twitch = config.get("twitch").cloned().unwrap_or(Value::Null);
            let refresh = match body.get("refresh_token") {
                Some(value) if js_truthy(Some(value)) => value.clone(),
                _ => twitch.get("refreshToken").cloned().unwrap_or(Value::Null),
            };
            crate::state::config::save_twitch_tokens(
                &mut config,
                &json!({
                    "userAccessToken": body.get("access_token").cloned().unwrap_or(Value::Null),
                    "refreshToken": refresh,
                    "broadcasterId": twitch.get("broadcasterId").cloned().unwrap_or(Value::Null),
                    "expiresAt": expires_at,
                }),
            );
        })
    };

    let refresher = Arc::new(TokenRefresher::new(TokenRefresherConfig {
        token_url: TOKEN_URL.to_string(),
        label: "twitch".to_string(),
        access_token_key: "userAccessToken".to_string(),
        get_config,
        build_params: Arc::new(|twitch: &Value| token_refresh::refresh_params(twitch, &[])),
        save_tokens,
        post_form: Arc::new(|url: &str, fields: &[(String, String)]| http::form_post(url, fields)),
        now: None,
        log: None,
    }));

    let ensure = {
        let refresher = Arc::clone(&refresher);
        let closure: Arc<dyn Fn() -> TokenFuture + Send + Sync> = Arc::new(move || {
            let refresher = Arc::clone(&refresher);
            Box::pin(async move { refresher.ensure_access_token().await })
        });
        closure
    };
    let refresh = {
        let refresher = Arc::clone(&refresher);
        let closure: Arc<dyn Fn() -> TokenFuture + Send + Sync> = Arc::new(move || {
            let refresher = Arc::clone(&refresher);
            Box::pin(async move { refresher.refresh_access_token().await })
        });
        closure
    };
    Tokens { ensure, refresh }
}

/// Отправка в чат и модерация через Helix: настоящий `PostFn` плюс обновлятель
/// токенов поверх того же HTTP (без сети в тестах — там `ChatSender` собран
/// вручную).
fn build_chat_sender(config: Arc<Mutex<ConfigFile>>) -> ChatSender {
    let post = http::helix_post(Arc::clone(&config));
    ChatSender::new(
        post,
        twitch_tokens(config),
        ChatRateLimiter::new(CHAT_SEND_INTERVAL_MS),
    )
    .with_sleep(Arc::new(|ms| {
        Box::pin(tokio::time::sleep(Duration::from_millis(ms.max(0) as u64)))
    }))
    .with_clock(Arc::new(|| chrono::Utc::now().timestamp_millis()))
}

/// Подписка EventSub через Helix: по запросу на подписку, с повтором после `401`
/// (как `subscribeWithRetry` в JS).
fn build_eventsub_subscribe(
    config: Arc<Mutex<ConfigFile>>,
    tokens: Tokens,
) -> crate::integrations::twitch_eventsub_control::SubscribeFn {
    let post = http::helix_post(Arc::clone(&config));
    Arc::new(move |session_id: String| {
        let config = Arc::clone(&config);
        let tokens = tokens.clone();
        let post = Arc::clone(&post);
        Box::pin(async move {
            let broadcaster_id = {
                let config = config.lock().unwrap_or_else(|error| error.into_inner());
                config
                    .get("twitch")
                    .and_then(|twitch| twitch.get("broadcasterId"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            };
            if broadcaster_id.is_empty() {
                return Err("no broadcasterId".to_string());
            }
            let mut token = (tokens.ensure)().await?;
            let subscriptions =
                crate::integrations::twitch_eventsub::subscriptions(&broadcaster_id);
            for subscription in &subscriptions {
                let body = json!({
                    "type": subscription["type"],
                    "version": subscription["version"],
                    "condition": subscription["condition"],
                    "transport": { "method": "websocket", "session_id": session_id },
                });
                let mut outcome = post(SUBSCRIBE_URL, &token, &body).await;
                if outcome.network_error.is_some() {
                    return Err("network".to_string());
                }
                if outcome.status == 401 {
                    token = (tokens.refresh)().await?;
                    outcome = post(SUBSCRIBE_URL, &token, &body).await;
                }
                if !(200..300).contains(&outcome.status) {
                    return Err(format!("subscribe {}", outcome.status));
                }
            }
            Ok(())
        })
    })
}

/// База Helix — как `https://api.twitch.tv/helix` в JS.
const HELIX_API: &str = "https://api.twitch.tv/helix";

/// Начальные счётчики фолловеров/подписчиков после подписки — как
/// `fetchInitialStats` в `twitch-eventsub.js`. Возвращает снимок или `None`,
/// если счётчики получить не удалось.
fn build_initial_stats(config: Arc<Mutex<ConfigFile>>, tokens: Tokens) -> StatsFn {
    Arc::new(move || {
        let config = Arc::clone(&config);
        let tokens = tokens.clone();
        Box::pin(async move {
            let (client_id, broadcaster_id) = {
                let config = config.lock().unwrap_or_else(|error| error.into_inner());
                let twitch = config.get("twitch").cloned().unwrap_or(Value::Null);
                let text = |key: &str| {
                    twitch
                        .get(key)
                        .map(crate::state::js_string)
                        .unwrap_or_default()
                };
                (text("clientId"), text("broadcasterId"))
            };
            if client_id.is_empty() || broadcaster_id.is_empty() {
                return None;
            }
            let Ok(token) = (tokens.ensure)().await else {
                return None;
            };
            let mut snapshot = Map::new();
            let followers = http::helix_get(
                format!("{HELIX_API}/channels/followers?broadcaster_id={broadcaster_id}&first=1"),
                client_id.clone(),
                token.clone(),
            )
            .await;
            if (200..300).contains(&followers.0) {
                if let Some(total) = followers.1.get("total") {
                    snapshot.insert("followerCount".to_string(), total.clone());
                }
            }
            let subscribers = http::helix_get(
                format!("{HELIX_API}/subscriptions?broadcaster_id={broadcaster_id}&first=1"),
                client_id,
                token,
            )
            .await;
            if (200..300).contains(&subscribers.0) {
                if let Some(total) = subscribers.1.get("total") {
                    snapshot.insert("subscriberCount".to_string(), total.clone());
                }
            }
            if snapshot.is_empty() {
                None
            } else {
                Some(Value::Object(snapshot))
            }
        })
    })
}

/// Обновлятель токенов DonationAlerts: как у Twitch, но параметры обмена
/// включают `redirect_uri`, а токены сохраняются в свой раздел настроек.
fn donation_alerts_tokens(config: Arc<Mutex<ConfigFile>>, port: u16) -> Tokens {
    let get_config = {
        let config = Arc::clone(&config);
        Arc::new(move || {
            config
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .get("donationAlerts")
                .cloned()
                .unwrap_or(Value::Null)
        })
    };
    let save_tokens = {
        let config = Arc::clone(&config);
        Arc::new(move |body: &Value, expires_at: i64| {
            let mut config = config.lock().unwrap_or_else(|error| error.into_inner());
            let service = config.get("donationAlerts").cloned().unwrap_or(Value::Null);
            let refresh = match body.get("refresh_token") {
                Some(value) if js_truthy(Some(value)) => value.clone(),
                _ => service.get("refreshToken").cloned().unwrap_or(Value::Null),
            };
            let user_id = match body.get("user_id") {
                Some(value) if js_truthy(Some(value)) => value.clone(),
                _ => service.get("userId").cloned().unwrap_or(Value::Null),
            };
            crate::state::config::save_donation_alerts_tokens(
                &mut config,
                &json!({
                    "accessToken": body.get("access_token").cloned().unwrap_or(Value::Null),
                    "refreshToken": refresh,
                    "userId": user_id,
                    "expiresAt": expires_at,
                }),
            );
        })
    };

    let refresher = Arc::new(TokenRefresher::new(TokenRefresherConfig {
        token_url: DA_OAUTH_URL.to_string(),
        label: "donationalerts".to_string(),
        access_token_key: "accessToken".to_string(),
        get_config,
        // `scope` не отправляем: по RFC 6749 §6 отсутствие означает «тот же набор
        // прав», иначе у старых авторизаций обновление падало бы на `invalid_scope`.
        build_params: Arc::new(move |service: &Value| {
            let mut params = token_refresh::refresh_params(service, &[]);
            params.push((
                "redirect_uri".to_string(),
                format!("http://localhost:{port}/oauth/donationalerts/callback"),
            ));
            params
        }),
        save_tokens,
        post_form: Arc::new(|url: &str, fields: &[(String, String)]| http::form_post(url, fields)),
        now: None,
        log: None,
    }));

    let ensure = {
        let refresher = Arc::clone(&refresher);
        let closure: Arc<dyn Fn() -> TokenFuture + Send + Sync> = Arc::new(move || {
            let refresher = Arc::clone(&refresher);
            Box::pin(async move { refresher.ensure_access_token().await })
        });
        closure
    };
    let refresh = {
        let refresher = Arc::clone(&refresher);
        let closure: Arc<dyn Fn() -> TokenFuture + Send + Sync> = Arc::new(move || {
            let refresher = Arc::clone(&refresher);
            Box::pin(async move { refresher.refresh_access_token().await })
        });
        closure
    };
    Tokens { ensure, refresh }
}

/// Обновлятель токенов YouTube: как у остальных служб, но токены — в разделе
/// `youtube` (`accessToken`/`refreshToken`/`expiresAt`).
fn youtube_tokens(config: Arc<Mutex<ConfigFile>>) -> Tokens {
    let get_config = {
        let config = Arc::clone(&config);
        Arc::new(move || {
            config
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .get("youtube")
                .cloned()
                .unwrap_or(Value::Null)
        })
    };
    let save_tokens = {
        let config = Arc::clone(&config);
        Arc::new(move |body: &Value, expires_at: i64| {
            let mut config = config.lock().unwrap_or_else(|error| error.into_inner());
            let service = config.get("youtube").cloned().unwrap_or(Value::Null);
            let refresh = match body.get("refresh_token") {
                Some(value) if js_truthy(Some(value)) => value.clone(),
                _ => service.get("refreshToken").cloned().unwrap_or(Value::Null),
            };
            crate::state::config::save_youtube_tokens(
                &mut config,
                &json!({
                    "accessToken": body.get("access_token").cloned().unwrap_or(Value::Null),
                    "refreshToken": refresh,
                    "expiresAt": expires_at,
                }),
            );
        })
    };

    let refresher = Arc::new(TokenRefresher::new(TokenRefresherConfig {
        token_url: YOUTUBE_TOKEN_URL.to_string(),
        label: "youtube".to_string(),
        access_token_key: "accessToken".to_string(),
        get_config,
        build_params: Arc::new(|service: &Value| token_refresh::refresh_params(service, &[])),
        save_tokens,
        post_form: Arc::new(|url: &str, fields: &[(String, String)]| http::form_post(url, fields)),
        now: None,
        log: None,
    }));

    let ensure = {
        let refresher = Arc::clone(&refresher);
        let closure: Arc<dyn Fn() -> TokenFuture + Send + Sync> = Arc::new(move || {
            let refresher = Arc::clone(&refresher);
            Box::pin(async move { refresher.ensure_access_token().await })
        });
        closure
    };
    let refresh = {
        let refresher = Arc::clone(&refresher);
        let closure: Arc<dyn Fn() -> TokenFuture + Send + Sync> = Arc::new(move || {
            let refresher = Arc::clone(&refresher);
            Box::pin(async move { refresher.refresh_access_token().await })
        });
        closure
    };
    Tokens { ensure, refresh }
}

/// OAuth-данные сокета: `GET /api/v1/user/oauth` (с повтором после `401`).
fn build_da_oauth(tokens: Tokens) -> OauthFn {
    Arc::new(move |access: String| {
        let tokens = tokens.clone();
        Box::pin(async move {
            let mut token = access;
            let (mut status, mut body) =
                http::bearer_get(DA_USER_URL.to_string(), token.clone()).await;
            if status == 401 {
                token = (tokens.refresh)().await?;
                (status, body) = http::bearer_get(DA_USER_URL.to_string(), token).await;
            }
            if !(200..300).contains(&status) {
                return Err(format!("user/oauth: {status}"));
            }
            parse_user_oauth(&body)
        })
    })
}

/// HTTP-подписка Centrifugo: `POST /api/v1/centrifuge/subscribe` (повтор после `401`).
fn build_da_subscribe(tokens: Tokens) -> DaSubscribeFn {
    Arc::new(
        move |channels: Vec<String>, client: String, access: String| {
            let tokens = tokens.clone();
            Box::pin(async move {
                let mut token = access;
                let payload = json!({ "channels": channels, "client": client });
                let (mut status, mut body) =
                    http::bearer_post(DA_SUBSCRIBE_URL.to_string(), token.clone(), payload.clone())
                        .await;
                if status == 401 {
                    token = (tokens.refresh)().await?;
                    (status, body) =
                        http::bearer_post(DA_SUBSCRIBE_URL.to_string(), token, payload).await;
                }
                if !(200..300).contains(&status) {
                    return Err(format!("subscribe: {status}"));
                }
                Ok(body
                    .get("channels")
                    .or_else(|| body.get("data").and_then(|data| data.get("channels")))
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default())
            })
        },
    )
}

/// Разобрать `user/oauth`: идентификатор пользователя и токен подключения.
fn parse_user_oauth(body: &Value) -> Result<Oauth, String> {
    let user = body.get("data").unwrap_or(body);
    let Some(user_id) = user.get("id").filter(|id| !id.is_null()) else {
        return Err("user/oauth response is missing user.id".to_string());
    };
    let connection_token = user
        .get("socket_connection_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    if connection_token.is_empty() {
        return Err("user/oauth response has no valid socket_connection_token".to_string());
    }
    Ok(Oauth {
        user_id: crate::state::js_string(user_id),
        connection_token,
    })
}

/// Обработчики событий шины, которые в `index.js` висят на `bus.on(...)`.
///
/// Делаем то, что уже есть в порте: алерты, счётчики фолловеров/подписчиков,
/// саундборд, озвучка награды, запросы камеры и сцены (уходят в OBS через
/// [`ObsClient`], как `setCameraAngle`/`setCameraFilter`/`SCENE_SET` в JS).
/// То, чем пользуются обработчики шины: собранные под `Arc` части состояния и два
/// внешних обработчика (смена сцены по награде, нативное уведомление).
struct BusContext {
    config: Arc<Mutex<ConfigFile>>,
    runtime: Arc<Mutex<Runtime>>,
    queue: Arc<AlertQueue>,
    clients: Arc<ClientRegistry>,
    obs: Arc<ObsClient>,
    database: Arc<Database>,
    remote_scene: Arc<OnceLock<RemoteSceneFn>>,
    notifier: Arc<OnceLock<NotifyFn>>,
}

fn apply_bus_event(event: &Value, ctx: &BusContext) {
    let BusContext {
        config,
        runtime,
        queue,
        clients,
        obs,
        database,
        remote_scene,
        notifier,
    } = ctx;
    let kind = event["type"].as_str().unwrap_or("");
    let payload = event.get("payload").cloned().unwrap_or(Value::Null);
    match kind {
        "alert" => {
            publish_alert_static(&payload, config, queue, clients);
            apply_alert_side_effects(&payload, config, runtime, database, clients);
            // Нативное уведомление — как `onStreamAlert` в `main.js`: когда панель
            // в фокусе, реальные события не дублируются (решает оболочка).
            if let Some(notify) = notifier.get() {
                notify(&payload);
            }
        }
        "stat_snapshot" => {
            let stats = runtime
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .set_stats(&payload);
            broadcast_clients(clients, event_types::STAT_UPDATE, stats);
        }
        "stat_delta" => {
            let stats = runtime
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .adjust_stats(&payload);
            broadcast_clients(clients, event_types::STAT_UPDATE, stats);
        }
        "soundboard_play" => broadcast_clients(clients, event_types::SOUNDBOARD_PLAY, payload),
        "camera_angle_request" => {
            // Награда/событие просит ракурс — OBS переключит источники и
            // сообщит обратно `camera_angle_changed`.
            let angle_id = payload
                .get("angleId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if !angle_id.is_empty() {
                let obs = Arc::clone(obs);
                std::mem::drop(tauri::async_runtime::spawn(async move {
                    let _ = obs.set_camera_angle(&angle_id).await;
                }));
            }
        }
        "camera_filter_request" => {
            let filter_id = payload
                .get("filterId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if !filter_id.is_empty() {
                let obs = Arc::clone(obs);
                std::mem::drop(tauri::async_runtime::spawn(async move {
                    // Без срока — переключение текущего состояния, как в JS.
                    let _ = obs.trigger_camera_filter(&filter_id, None).await;
                }));
            }
        }
        "reward_scene_request" => {
            // Как `handleRemoteAction("SCENE_SET", { scene })`: маппинг сцен,
            // заставка, активная сцена и кадр пульту. Сам `SCENE_SET` живёт в
            // оболочке пульта — она и ставит обработчик.
            let scene = payload.get("scene").cloned().unwrap_or(Value::Null);
            if js_truthy(Some(&scene)) {
                if let Some(handler) = remote_scene.get() {
                    handler(json!({ "scene": scene }));
                }
            }
        }
        "goal_external_update" => {
            // Порт `bus.on("goal_external_update")`: цель правится в настройках,
            // затем панель получает свежий срез.
            let goal = {
                let mut config = config.lock().unwrap_or_else(|error| error.into_inner());
                crate::state::config::set_goal(&mut config, &payload)
            };
            broadcast_clients(clients, event_types::GOAL_UPDATE, goal);
        }
        "camera_angle_changed" => {
            let active = payload
                .get("activeCameraAngle")
                .cloned()
                .unwrap_or(Value::Null);
            runtime
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .set_active_camera_angle(&active);
            broadcast_clients(
                clients,
                event_types::CAMERA_ANGLE_UPDATE,
                json!({ "activeCameraAngle": active }),
            );
        }
        "camera_filter_changed" => {
            let filter_id = payload.get("filterId").cloned().unwrap_or(Value::Null);
            let active = js_truthy(payload.get("active"));
            runtime
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .set_active_filter(&filter_id, active);
            broadcast_clients(
                clients,
                event_types::CAMERA_FILTER_UPDATE,
                json!({ "filterId": filter_id, "active": active }),
            );
        }
        "reward_tts" => {
            let text = payload.get("text").and_then(Value::as_str).unwrap_or("");
            if !text.is_empty() {
                broadcast_clients(clients, event_types::REWARD_TTS, json!({ "text": text }));
            }
        }
        _ => {}
    }
}

/// Побочные эффекты алерта — порт хвоста `bus.on("alert")` в `index.js`:
/// «последние события», запись в историю, счёт текущего стрима, цель сбора и
/// лучший донат. Колесо исключено — оно не событие стрима (см. JS).
fn apply_alert_side_effects(
    alert: &Value,
    config: &Arc<Mutex<ConfigFile>>,
    runtime: &Arc<Mutex<Runtime>>,
    database: &Arc<Database>,
    clients: &Arc<ClientRegistry>,
) {
    let kind = alert.get("kind").and_then(Value::as_str).unwrap_or("");
    if kind == "wheel_start" || kind == "wheel_winner" {
        return;
    }
    let now = chrono::Utc::now().timestamp_millis();

    // `amount: alert.amount ?? alert.count` — именно `null` уводит к `count`,
    // а `0` остаётся суммой.
    let amount = alert
        .get("amount")
        .filter(|value| !value.is_null())
        .cloned()
        .or_else(|| alert.get("count").cloned())
        .unwrap_or(Value::Null);
    let recent = {
        let mut runtime = runtime.lock().unwrap_or_else(|error| error.into_inner());
        runtime.push_recent_event(
            &json!({
                "kind": alert.get("kind").cloned().unwrap_or(Value::Null),
                "user": alert.get("user").cloned().unwrap_or(Value::Null),
                "amount": amount,
                "message": alert.get("message").cloned().unwrap_or(Value::Null),
            }),
            now,
        );
        runtime.recent_events().first().cloned()
    };
    if let Some(recent) = recent {
        broadcast_clients(clients, event_types::RECENT_EVENT, recent);
    }

    let is_test = js_truthy(alert.get("isTest"));
    database.append_stream_event(&crate::server::utils::to_stream_event(alert, is_test, now));

    if kind != "donation" {
        return;
    }
    // В JS сумма обязана быть числом: строка попадает в историю, а в счёт — нет.
    if alert.get("amount").and_then(Value::as_f64).is_none() {
        return;
    }
    // Подтянутые с DonationAlerts донаты случились в прошлой сессии — их в
    // «за этот стрим» не считаем (цель и лучший донат при этом обновляем).
    if !js_truthy(alert.get("recovered")) {
        let session = runtime
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .add_donation_to_session(
                alert.get("amount").unwrap_or(&Value::Null),
                alert.get("currency").unwrap_or(&Value::Null),
            );
        broadcast_clients(clients, event_types::SESSION_STATS, session);
    }
    let (goal, top) = {
        let mut config = config.lock().unwrap_or_else(|error| error.into_inner());
        let goal = crate::state::config::add_to_goal(
            &mut config,
            alert.get("amount").unwrap_or(&Value::Null),
        );
        let top = crate::state::scenes::maybe_update_top_donation(
            &mut config,
            &json!({
                "user": alert.get("user").cloned().unwrap_or(Value::Null),
                "amount": alert.get("amount").cloned().unwrap_or(Value::Null),
                "currency": alert.get("currency").cloned().unwrap_or(Value::Null),
            }),
        );
        (goal, top)
    };
    broadcast_clients(clients, event_types::GOAL_UPDATE, goal);
    if let Some(top) = top {
        broadcast_clients(clients, event_types::TOP_DONATION_UPDATE, top);
    }
}

/// Побочные эффекты сообщения чата — порт `bus.on("chat_message")` из
/// `index.js`: запись в историю (с id текущей сессии), розыгрыш и опрос по
/// команде из чата. Тестовые сообщения историю и команды не трогают.
fn apply_chat_side_effects(
    message: &Value,
    database: &Arc<Database>,
    session: &Arc<Mutex<Option<Value>>>,
    runtime: &Arc<Mutex<Runtime>>,
    config: &Arc<Mutex<ConfigFile>>,
    clients: &Arc<ClientRegistry>,
) {
    let is_test = js_truthy(message.get("isTest"));
    if !is_test {
        let session_id = session
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .and_then(|session| session.get("id"))
            .cloned();
        if let Some(session_id) = session_id {
            let mut row = match message {
                Value::Object(map) => map.clone(),
                _ => Map::new(),
            };
            row.insert("sessionId".to_string(), session_id);
            database.append_chat(&Value::Object(row));
        }
    }
    if is_test {
        return;
    }

    let user = message.get("user").cloned().unwrap_or(Value::Null);
    let text = message.get("message").cloned().unwrap_or(Value::Null);

    let giveaway = runtime
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .handle_giveaway_chat(&user, &text);
    if let Some(giveaway) = giveaway {
        broadcast_clients(
            clients,
            event_types::GIVEAWAY_UPDATE,
            json!({ "giveaway": giveaway }),
        );
        broadcast_clients(
            clients,
            event_types::GIVEAWAY_PARTICIPANTS,
            json!({
                "count": giveaway.get("count").cloned().unwrap_or(Value::Null),
                "participants": giveaway.get("participants").cloned().unwrap_or(Value::Null),
            }),
        );
    }

    let poll = {
        let mut runtime = runtime.lock().unwrap_or_else(|error| error.into_inner());
        let config = config.lock().unwrap_or_else(|error| error.into_inner());
        crate::state::poll::handle_poll_chat(&mut runtime, &config, &user, &text)
    };
    if let Some(poll) = poll {
        broadcast_clients(clients, event_types::POLL_UPDATE, json!({ "poll": poll }));
    }
}

/// Публиковать алерт из события шины: длительность — по словарю, тест и
/// пропущенный донат — в мету, выключенная очередь рассылает напрямую
/// (как `bus.on("alert")` в JS).
fn publish_alert_static(
    alert: &Value,
    config: &Arc<Mutex<ConfigFile>>,
    queue: &Arc<AlertQueue>,
    clients: &Arc<ClientRegistry>,
) {
    let mut with_duration = alert.clone();
    if let Value::Object(map) = &mut with_duration {
        let kind = map.get("kind").and_then(Value::as_str).unwrap_or("follow");
        let duration = crate::protocol::alert_duration_ms(kind).unwrap_or(5000);
        map.entry("durationMs".to_string())
            .or_insert(Value::from(duration));
    }
    let enabled = {
        let config = config.lock().unwrap_or_else(|error| error.into_inner());
        crate::state::config::alert_queue_config(&config)["enabled"] != Value::Bool(false)
    };
    if !enabled {
        broadcast_clients(clients, event_types::ALERT, with_duration);
        return;
    }
    let is_test = js_truthy(with_duration.get("isTest"));
    queue.enqueue(
        &with_duration,
        &EnqueueMeta {
            force: is_test,
            ignore_pause: is_test,
            recovered: js_truthy(with_duration.get("recovered")),
            front: false,
        },
    );
}

/// Журнал доходит до панели тем же кадром, что `bus.on("terminal_log")` в JS.
struct ClientLogBus {
    clients: Arc<ClientRegistry>,
}

impl LogBus for ClientLogBus {
    fn emit(&self, event: &str, entry: &Value) {
        let text = json!({ "type": event, "payload": entry }).to_string();
        self.clients.broadcast_text(&text);
    }
}

/// Разослать кадр `{ type, payload }` всем клиентам.
fn broadcast_clients(clients: &ClientRegistry, kind: &str, payload: Value) {
    let text = json!({ "type": kind, "payload": payload }).to_string();
    clients.broadcast_text(&text);
}

/// Кадр `twitch_action_result`: `action` идёт первым, затем поля результата —
/// как `{ action, ...result }` в JS.
fn action_frame(action: &str, result: Value) -> Value {
    let mut payload = Map::new();
    payload.insert("action".to_string(), Value::from(action));
    if let Value::Object(fields) = result {
        for (key, value) in fields {
            payload.insert(key, value);
        }
    }
    json!({ "type": event_types::TWITCH_ACTION_RESULT, "payload": payload })
}

/// Момент доната в миллисекундах — для порядка «от старых к новым».
fn donated_at(donation: &Value) -> f64 {
    donation
        .get("createdAt")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
}

/// Отобрать донаты, которых ещё не было: не показанные сервисом и с `sourceId`,
/// которого нет в истории; от старых к новым (как в JS).
fn missed_donations(donations: &[Value], known: &HashSet<String>) -> Vec<Value> {
    let mut missed: Vec<Value> = donations
        .iter()
        .filter(|donation| !js_truthy(donation.get("shown")))
        .filter(|donation| {
            donation
                .get("sourceId")
                .and_then(Value::as_str)
                .map(|id| !id.is_empty() && !known.contains(id))
                .unwrap_or(true)
        })
        .cloned()
        .collect();
    missed.sort_by(|a, b| {
        donated_at(a)
            .partial_cmp(&donated_at(b))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    missed
}

/// Кадр `alert_queue_update` с результатом добора донатов — как `report` в JS.
fn queue_report(
    queue: &Arc<AlertQueue>,
    config: &Arc<Mutex<ConfigFile>>,
    recover: Value,
) -> String {
    let mut snapshot = queue.snapshot();
    let enabled = {
        let config = config.lock().unwrap_or_else(|error| error.into_inner());
        crate::state::config::alert_queue_config(&config)["enabled"] != Value::Bool(false)
    };
    if let Value::Object(map) = &mut snapshot {
        map.insert("enabled".to_string(), Value::Bool(enabled));
    }
    json!({
        "type": event_types::ALERT_QUEUE_UPDATE,
        "payload": { "queue": snapshot, "recover": recover },
    })
    .to_string()
}

/// Собрать payload `soundboard_play` по звуку из настроек; `None` — нет такого.
///
/// Заголовок — `title || rewardTitle || id`, имя пользователя — `user ||
/// "Stream Deck"`. Отсутствующие `audioFile`/`imageFile` в JSON не попадают:
/// в JS они уходили как `undefined` и так же исчезали при `JSON.stringify`.
fn soundboard_payload(config: &ConfigFile, sound_id: &str, user: &str) -> Option<Value> {
    let sound = config
        .get("soundboard")
        .and_then(|soundboard| soundboard.get("sounds"))
        .and_then(Value::as_array)
        .and_then(|sounds| {
            sounds
                .iter()
                .find(|sound| sound.get("id").and_then(Value::as_str) == Some(sound_id))
                .cloned()
        })?;
    let id = sound.get("id").cloned().unwrap_or(Value::Null);
    let title = sound
        .get("title")
        .filter(|value| js_truthy(Some(value)))
        .or_else(|| {
            sound
                .get("rewardTitle")
                .filter(|value| js_truthy(Some(value)))
        })
        .cloned()
        .unwrap_or_else(|| id.clone());
    let user = if user.is_empty() { "Stream Deck" } else { user };

    let mut payload = Map::new();
    payload.insert("soundId".to_string(), id);
    payload.insert("title".to_string(), title);
    payload.insert("user".to_string(), Value::from(user));
    for key in ["audioFile", "imageFile"] {
        if let Some(value) = sound.get(key) {
            payload.insert(key.to_string(), value.clone());
        }
    }
    Some(Value::Object(payload))
}

/// Собрать очередь алертов: правила из настроек, таймеры на рантайме, события —
/// в шину (аналоги `onPlay`/`onChange` в JS).
fn build_alert_queue(
    config: Arc<Mutex<ConfigFile>>,
    clients: Arc<ClientRegistry>,
) -> Arc<AlertQueue> {
    let rules = {
        let config = config.lock().unwrap_or_else(|error| error.into_inner());
        rules_from(&config)
    };

    let play_clients = Arc::clone(&clients);
    let on_play: Arc<PlayFn> = Arc::new(move |item: &Value| {
        let text = json!({ "type": event_types::ALERT, "payload": item }).to_string();
        play_clients.broadcast_text(&text);
    });

    let change_config = Arc::clone(&config);
    let change_clients = Arc::clone(&clients);
    let on_change: Arc<ChangeFn> = Arc::new(move |change: &Value| {
        let mut queue = change.clone();
        let reason = queue.get("reason").cloned().unwrap_or(Value::Null);
        if let Value::Object(map) = &mut queue {
            map.remove("reason");
            let enabled = {
                let config = change_config
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                crate::state::config::alert_queue_config(&config)["enabled"] != Value::Bool(false)
            };
            map.insert("enabled".to_string(), Value::Bool(enabled));
        }
        let text = json!({
            "type": event_types::ALERT_QUEUE_UPDATE,
            "payload": { "queue": queue, "reason": reason },
        })
        .to_string();
        change_clients.broadcast_text(&text);
    });

    AlertQueue::new(AlertQueueOptions {
        clock: None,
        schedule: Arc::new(schedule_timer),
        cancel: Arc::new(cancel_timer),
        on_play: Some(on_play),
        on_change: Some(on_change),
        rules: Some(rules),
        tail_ms: None,
    })
}

/// Правила очереди из настроек — с теми же умолчаниями, что у `normalize_config`
/// (поэтому очередь можно собирать до нормализации настроек).
fn rules_from(config: &ConfigFile) -> Rules {
    let queue = crate::state::config::alert_queue_config(config);
    Rules {
        min_amount: js_number_or_zero(queue.get("min_amount")).max(0.0),
        merge_same_user: queue.get("merge_same_user") != Some(&Value::Bool(false)),
        merge_window_sec: match queue.get("merge_window_sec").and_then(Value::as_f64) {
            // Как `set_rules`: только `max(0)`, без округления и обрезки до 600 —
            // JS берёт значение из конфига как есть.
            Some(seconds) => seconds.max(0.0),
            None => 20.0,
        },
    }
}

/// Серверный цикл «Колеса Фортуны» — порт `isSpinning` и трёх таймеров из
/// `createServer` (`server/index.js`).
///
/// В JS это жило в замыкании `createServer`; здесь — рядом с остальным живым
/// состоянием, потому что его правят и команды панели, и действия пульта.
/// Смысл тот же: спин считается идущим, пока страница колеса не пришлёт
/// `cmd_set_giveaway_winner`, а таймеры прячут колесо по окончании цикла и
/// крутят его снова в режиме выбывания.
pub struct WheelCycle {
    runtime: Arc<Mutex<Runtime>>,
    clients: Arc<ClientRegistry>,
    log_bus: Arc<dyn LogBus>,
    state: Mutex<WheelState>,
}

#[derive(Default)]
struct WheelState {
    spinning: bool,
    spin_timeout: Option<TimerId>,
    auto_spin: Option<TimerId>,
    hide: Option<TimerId>,
}

/// Предохранитель спина: страница колеса отвечает за ~5.3 с, берём с запасом.
const SPIN_TIMEOUT_MS: u64 = 15_000;
/// Пауза перед следующим спином в режиме выбывания (как `scheduleAutoSpin`).
const AUTO_SPIN_MS: u64 = 1_800;

impl WheelCycle {
    fn new(
        runtime: Arc<Mutex<Runtime>>,
        clients: Arc<ClientRegistry>,
        log_bus: Arc<dyn LogBus>,
    ) -> Arc<Self> {
        Arc::new(Self {
            runtime,
            clients,
            log_bus,
            state: Mutex::new(WheelState::default()),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, WheelState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub fn is_spinning(&self) -> bool {
        self.lock().spinning
    }

    /// `clearWheelHide`: снять таймер автоскрытия (новый спин покажет колесо).
    pub fn clear_hide(&self) {
        if let Some(id) = self.lock().hide.take() {
            cancel_timer(id);
        }
    }

    /// `clearAutoSpin`: снять таймер следующего спина в режиме выбывания.
    pub fn clear_auto_spin(&self) {
        if let Some(id) = self.lock().auto_spin.take() {
            cancel_timer(id);
        }
    }

    /// `endSpin`: спин завершён, предохранитель снят.
    pub fn end_spin(&self) {
        let id = {
            let mut state = self.lock();
            state.spinning = false;
            state.spin_timeout.take()
        };
        if let Some(id) = id {
            cancel_timer(id);
        }
    }

    /// `clearAutoSpin` + `clearWheelHide` + `endSpin` — как в `WHEEL_START`,
    /// сбросе участников и остановке сервера.
    pub fn reset(&self) {
        self.clear_auto_spin();
        self.clear_hide();
        self.end_spin();
    }

    /// `beginSpin`: спин идёт, пока страница колеса не ответит победителем.
    ///
    /// Предохранитель — на случай, если страницу в OBS перезагрузили и ответа не
    /// будет никогда: иначе запрет на новый спин остался бы навсегда, и кнопка
    /// «Крутить» молча перестала бы работать до перезапуска приложения.
    pub fn begin_spin(self: &Arc<Self>) {
        let previous = {
            let mut state = self.lock();
            state.spinning = true;
            state.spin_timeout.take()
        };
        if let Some(id) = previous {
            cancel_timer(id);
        }
        let this = Arc::clone(self);
        let id = schedule_timer(
            Box::new(move || {
                let expired = {
                    let mut state = this.lock();
                    let expired = state.spinning;
                    state.spinning = false;
                    state.spin_timeout = None;
                    expired
                };
                if expired {
                    Logger::new("server", Some(Arc::clone(&this.log_bus))).warn(
                        "спин колеса не завершился: страница колеса не прислала победителя — запрет на новый спин снят",
                        None,
                    );
                }
            }),
            SPIN_TIMEOUT_MS,
        );
        self.lock().spin_timeout = Some(id);
    }

    /// `scheduleWheelHide`: спрятать колесо, когда карточка результата уйдёт.
    pub fn schedule_hide(self: &Arc<Self>, delay_ms: u64) {
        self.clear_hide();
        let this = Arc::clone(self);
        let id = schedule_timer(
            Box::new(move || {
                this.lock().hide = None;
                if this.lock().spinning {
                    return; // только что запустили новый спин — не скрываем
                }
                broadcast_clients(
                    &this.clients,
                    event_types::GIVEAWAY_WHEEL,
                    json!({ "sectors": [] }),
                );
            }),
            delay_ms,
        );
        self.lock().hide = Some(id);
    }

    /// `scheduleAutoSpin`: в режиме выбывания крутить следующего.
    pub fn schedule_auto_spin(self: &Arc<Self>) {
        self.clear_auto_spin();
        let this = Arc::clone(self);
        let id = schedule_timer(
            Box::new(move || {
                this.lock().auto_spin = None;
                this.spin_if_idle();
            }),
            AUTO_SPIN_MS,
        );
        self.lock().auto_spin = Some(id);
    }

    /// Общий путь спина (`CMD_SPIN_WHEEL`, `WHEEL_SPIN`, автоспин):
    /// `clearWheelHide`; если уже крутится — выйти; иначе разослать сектора,
    /// выбрать победителя и запустить спин. `true` — спин начался.
    pub fn spin_if_idle(self: &Arc<Self>) -> bool {
        self.clear_hide();
        if self.lock().spinning {
            return false;
        }
        let (sectors, winner) = {
            let mut runtime = self
                .runtime
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let sectors = runtime.giveaway_snapshot()["participants"].clone();
            (sectors, runtime.pick_random_winner())
        };
        broadcast_clients(
            &self.clients,
            event_types::GIVEAWAY_WHEEL,
            json!({ "sectors": sectors }),
        );
        let Some(winner) = winner else {
            return false;
        };
        self.begin_spin();
        broadcast_clients(
            &self.clients,
            event_types::GIVEAWAY_SPIN,
            json!({ "winner": winner }),
        );
        true
    }

    /// Конец раунда после `cmd_set_giveaway_winner`: `endSpin` и следующий шаг —
    /// автоспин при выбывании или автоскрытие, когда цикл закончен.
    pub fn finish_round(self: &Arc<Self>, giveaway: &Value) {
        self.end_spin();
        let is_final = js_truthy(giveaway.get("isFinalWinner"));
        let is_elimination = js_truthy(giveaway.get("eliminationMode")) && !is_final;
        if is_elimination {
            self.schedule_auto_spin();
        } else if crate::server::utils::should_hide_wheel_after_spin(giveaway) {
            let delay = crate::protocol::alert_duration_ms("wheel_winner").unwrap_or(8000) as u64;
            self.schedule_hide(delay);
        }
    }
}

/// Таймеры очереди: идентификатор → отмена.
fn timers() -> &'static Mutex<HashMap<TimerId, oneshot::Sender<()>>> {
    static TIMERS: OnceLock<Mutex<HashMap<TimerId, oneshot::Sender<()>>>> = OnceLock::new();
    TIMERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Поставить таймер очереди: через `ms` вызвать `on_fire`, если не отменили.
fn schedule_timer(on_fire: Box<dyn FnOnce() + Send>, ms: u64) -> TimerId {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let id = NEXT.fetch_add(1, Ordering::SeqCst) + 1;
    let (sender, receiver) = oneshot::channel::<()>();
    timers()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(id, sender);
    std::mem::drop(tauri::async_runtime::spawn(async move {
        // Отмена приходит раньше срока — тогда таймер просто не срабатывает.
        let cancelled = tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(ms)) => false,
            _ = receiver => true,
        };
        forget_timer(id);
        if !cancelled {
            on_fire();
        }
    }));
    id
}

/// Снять таймер очереди.
fn cancel_timer(id: TimerId) {
    if let Some(sender) = timers()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(&id)
    {
        let _ = sender.send(());
    }
}

/// Забыть отработавший таймер, чтобы карта не росла.
fn forget_timer(id: TimerId) {
    timers()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(&id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::paths::Storage;
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Временный каталог с шаблоном настроек: так `Diagnostics::open` проходит
    /// тот же путь, что и при первом запуске приложения.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            static COUNTER: AtomicUsize = AtomicUsize::new(0);
            let index = COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir().join(format!(
                "ose-diagnostics-{}-{label}-{index}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("временный каталог должен создаваться");
            fs::write(dir.join("config.example.json"), "{\n  \"port\": 8710\n}\n")
                .expect("шаблон должен записываться");
            Self(dir)
        }

        fn storage(&self) -> Storage {
            Storage::beside_sources(self.0.clone())
        }

        fn write_config(&self, text: &str) {
            fs::write(self.0.join("config.json"), text).expect("настройки должны записываться");
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).ok();
        }
    }

    #[test]
    fn port_comes_from_config_and_survives_bad_input() {
        for (text, expected) in [
            (Some("{\"port\":1234}"), Some(1234)),
            (Some("{\"port\":\"1234\"}"), None), // строка — не число
            (Some("{\"port\":70000}"), None),    // вне диапазона u16
            (Some("{\"port\":0}"), Some(0)),
            // Битый файл уходит в карантин, а настройки разворачиваются из
            // шаблона поставки — значит, и порт берётся оттуда.
            (Some("не json"), Some(8710)),
            (Some("{\"other\":1}"), None), // поля нет — решает вызывающий
            (None, Some(8710)),            // первого запуска тоже касается
        ] {
            let dir = TempDir::new("port");
            if let Some(text) = text {
                dir.write_config(text);
            }

            let diagnostics =
                Diagnostics::open(dir.storage()).expect("диагностика должна открыться");
            assert_eq!(diagnostics.configured_port(), expected, "вход: {text:?}");
        }
    }

    #[test]
    fn health_report_is_the_short_shape_the_panel_expects() {
        let dir = TempDir::new("health");
        let diagnostics = Diagnostics::open(dir.storage()).expect("диагностика");

        let report = diagnostics.health_report(8710, true);

        assert_eq!(report["ok"], json!(true));
        assert_eq!(report["port"], json!(8710));
        assert_eq!(report["listening"], json!(true));
        assert_eq!(report["server"]["clients"], json!(0));
        assert_eq!(report["version"], json!(env!("CARGO_PKG_VERSION")));
        // Пути в сетевой отчёт не попадают — это проверяет и сам health.
        let data_dir = dir.0.to_string_lossy().to_string();
        assert!(
            !report.to_string().contains(&data_dir),
            "путь к каталогу данных виден в отчёте: {report}"
        );
        assert_eq!(report["problems"], json!([]));
    }

    #[test]
    fn support_bundle_has_config_summary_files_and_no_paths() {
        let dir = TempDir::new("bundle");
        // Секрет лежит открытым текстом (как после ввода ключа в панели): при
        // открытии он расшифровывается не хуже, а в отчёт идёт только факт.
        dir.write_config(
            "{\"port\":8710,\"twitch\":{\"channel\":\"halantar\",\"clientSecret\":\"живой-секрет\"}}",
        );
        let diagnostics = Diagnostics::open(dir.storage()).expect("диагностика");

        let bundle = diagnostics.support_bundle(8710, true);
        let text = diagnostics.support_bundle_text(8710, true);

        assert_eq!(bundle["config"]["twitch"]["channel"], json!("halantar"));
        // Секрет из файла настроек в отчёт не попал.
        assert_eq!(
            bundle["config"]["filledFields"],
            json!(["twitch.clientSecret"])
        );
        assert!(!bundle.to_string().contains("живой-секрет"));
        assert!(bundle["config"]["twitch"]["clientSecret"].is_null());
        assert_eq!(bundle["integrity"]["backups"], json!([]));
        // Файлы данных перечислены по имени, без путей.
        let files: Vec<&str> = bundle["dataFiles"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|file| file["name"].as_str())
            .collect();
        assert!(files.contains(&"config.json"), "{files:?}");
        // Адрес пульта попадает в отчёт (как `remoteUrl` в JS) — с портом.
        let remote = bundle["environment"]["remoteUrl"]
            .as_str()
            .expect("адрес пульта должен быть в отчёте");
        assert!(remote.contains(":8710/remote"), "{remote}");
        assert!(text.starts_with('\u{FEFF}'));
        assert!(text.contains("== Настройки (без секретов) =="));
    }

    #[test]
    fn an_unreadable_saved_secret_is_flagged_for_the_panel() {
        let dir = TempDir::new("secret-unreadable");
        // Так выглядит конфиг, перенесённый с другой машины: зашифровать нечем.
        dir.write_config(r#"{ "donationAlerts": { "clientSecret": "enc:AAAA" } }"#);
        let diagnostics = Diagnostics::open(dir.storage()).expect("диагностика");

        let auth = &diagnostics.state_snapshot()["donationAlertsAuth"];
        // Секрет нечитаем: для сервиса он пуст, для пользователя — «введите заново».
        assert_eq!(auth["hasClientSecret"], json!(false));
        assert_eq!(auth["clientSecretUnreadable"], json!(true));
    }

    #[test]
    fn recovery_event_reaches_the_report() {
        let dir = TempDir::new("recovery");
        // Файл испорчен, копий нет — событие должно попасть в отчёт.
        dir.write_config("мусор без копий");
        let diagnostics = Diagnostics::open(dir.storage()).expect("диагностика");

        assert_eq!(diagnostics.recovery_events().len(), 1);
        let text = diagnostics.support_bundle_text(8710, true);
        assert!(text.contains("unrecoverable"), "{text}");
    }

    #[test]
    fn a_soundboard_trigger_builds_the_overlay_payload() {
        let dir = TempDir::new("soundboard");
        dir.write_config(
            r#"{ "soundboard": { "sounds": [
                { "id": "s1", "audioFile": "a.mp3", "imageFile": "a.png" },
                { "id": "s2", "rewardTitle": "Барабаны", "audioFile": "b.mp3" }
            ] } }"#,
        );
        let diagnostics = Diagnostics::open(dir.storage()).expect("диагностика");

        let config = diagnostics.config();
        // Ни `title`, ни `rewardTitle` — заголовком становится `id`.
        let first = soundboard_payload(&config, "s1", "Тест").expect("звук s1");
        assert_eq!(first["soundId"], json!("s1"));
        assert_eq!(first["title"], json!("s1"));
        assert_eq!(first["user"], json!("Тест"));
        assert_eq!(first["audioFile"], json!("a.mp3"));
        assert_eq!(first["imageFile"], json!("a.png"));
        // Пустой `user` — «Stream Deck», `rewardTitle` — заголовок, а
        // отсутствующий `imageFile` в JSON не попадает.
        let second = soundboard_payload(&config, "s2", "").expect("звук s2");
        assert_eq!(second["title"], json!("Барабаны"));
        assert_eq!(second["user"], json!("Stream Deck"));
        assert!(second.get("imageFile").is_none());
        // Незнакомый звук — ничего.
        assert!(soundboard_payload(&config, "ghost", "Тест").is_none());
        drop(config);

        assert!(diagnostics.trigger_soundboard("s1", "Тест"));
        assert!(!diagnostics.trigger_soundboard("ghost", "Тест"));
    }

    #[test]
    fn a_donation_alert_records_history_goal_and_recent_events() {
        use crate::storage::history::QueryOptions;

        let dir = TempDir::new("alert-effects");
        dir.write_config(
            r#"{ "alertQueue": { "enabled": false },
                 "goal": { "title": "Цель", "target": 1000, "current": 0, "currency": "RUB" } }"#,
        );
        let diagnostics = Diagnostics::open(dir.storage()).expect("диагностика");
        let emit = diagnostics.integration_emit();

        emit(json!({
            "type": event_types::ALERT,
            "payload": { "kind": "donation", "user": "Вася", "amount": 300, "currency": "RUB", "message": "Привет" },
        }));

        // Донат попал в историю — с именем и суммой.
        let page = diagnostics
            .database()
            .stream_events(&QueryOptions::default());
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0]["username"], json!("Вася"));
        assert_eq!(page.items[0]["amount"], json!(300));

        // «Последние события» — свежий донат первым.
        let recent = diagnostics.runtime().recent_events().to_vec();
        assert_eq!(recent[0]["kind"], json!("donation"));
        assert_eq!(recent[0]["user"], json!("Вася"));

        // Цель сбора и счёт текущего стрима.
        assert_eq!(
            diagnostics.config().get("goal").unwrap()["current"],
            json!(300)
        );
        assert_eq!(diagnostics.runtime().session_donations()["count"], json!(1));
    }

    #[test]
    fn only_unseen_donations_are_recovered_oldest_first() {
        let known: HashSet<String> = ["5".to_string()].into_iter().collect();
        let donations = vec![
            json!({ "sourceId": "9", "createdAt": 300, "shown": false, "user": "c" }),
            json!({ "sourceId": "5", "createdAt": 100, "shown": false, "user": "a" }),
            json!({ "sourceId": "7", "createdAt": 200, "shown": true, "user": "b" }),
            json!({ "sourceId": "8", "createdAt": 150, "shown": false, "user": "d" }),
            json!({ "createdAt": 50, "shown": false, "user": "e" }),
        ];
        let missed = missed_donations(&donations, &known);
        let users: Vec<&str> = missed
            .iter()
            .filter_map(|donation| donation["user"].as_str())
            .collect();
        // Известный по истории и показанный сервисом пропущены; без id — берём.
        assert_eq!(users, ["e", "d", "c"]);
    }

    #[test]
    fn a_stream_session_bounds_the_snapshot_and_records_chat() {
        let dir = TempDir::new("session");
        dir.write_config(r#"{ "twitch": { "channel": "halantar" } }"#);
        let diagnostics = Diagnostics::open(dir.storage()).expect("диагностика");
        diagnostics.start_stream_session();

        // Начало сессии попало в снимок — панель просит «только этот стрим».
        let started = diagnostics.state_snapshot()["sessionStartedAt"]
            .as_i64()
            .expect("время сессии");
        assert!(started > 0);

        // Сообщение чата записалось в историю с id сессии.
        let emit = diagnostics.chat_emit();
        emit(json!({
            "type": event_types::CHAT_MESSAGE,
            "payload": { "source": "twitch", "user": "viewer", "message": "привет" },
        }));
        let chat = diagnostics.database().chat(None);
        assert_eq!(chat.len(), 1);
        assert_eq!(chat[0]["username"], json!("viewer"));
        assert!(chat[0]["sessionId"].is_string());

        // Сессия закрывается и отмечается концом.
        diagnostics.end_stream_session();
        assert!(diagnostics.database().sessions()[0]["endedAt"].is_number());
    }

    #[test]
    fn a_service_logger_reaches_the_bus_and_marks_debug() {
        use axum::extract::ws::Message;
        use tokio::sync::mpsc;

        let dir = TempDir::new("logger");
        let diagnostics = Diagnostics::open(dir.storage()).expect("диагностика");
        let (tx, mut rx) = mpsc::unbounded_channel();
        diagnostics.clients().add("control".to_string(), false, tx);

        diagnostics.logger("server").info("привет", None);
        let frame = match rx.try_recv() {
            Ok(Message::Text(text)) => text.to_string(),
            other => panic!("ожидался текстовый кадр: {other:?}"),
        };
        let value: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(value["type"], json!("terminal_log"));
        assert_eq!(value["payload"]["service"], json!("server"));
        assert_eq!(value["payload"]["level"], json!("info"));
        assert_eq!(value["payload"]["message"], json!("привет"));
        assert_eq!(value["payload"]["data"], Value::Null);

        // Отладка идёт отдельным событием.
        diagnostics
            .logger("chat")
            .debug("кадр", Some(&json!({ "bytes": 371 })));
        let frame = match rx.try_recv() {
            Ok(Message::Text(text)) => text.to_string(),
            other => panic!("ожидался текстовый кадр: {other:?}"),
        };
        let value: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(value["type"], json!("debug_log"));
        assert_eq!(value["payload"]["data"]["bytes"], json!(371));
    }

    #[test]
    fn a_replayed_event_comes_back_and_a_missing_one_is_null() {
        let dir = TempDir::new("replay");
        dir.write_config(r#"{ "alertQueue": { "enabled": false } }"#);
        let diagnostics = Diagnostics::open(dir.storage()).expect("диагностика");
        diagnostics.database().append_stream_event(&json!({
            "id": "e1", "type": "donation", "username": "Вася", "amount": 300, "currency": "RUB",
        }));

        let record = diagnostics.replay_event(&json!("e1"));
        assert_eq!(record["username"], json!("Вася"));
        assert_eq!(record["type"], json!("donation"));
        assert_eq!(record["amount"], json!(300));

        // Неизвестный id — null, как в JS.
        assert_eq!(diagnostics.replay_event(&json!("нет")), Value::Null);
    }

    #[test]
    fn a_rotated_access_code_changes_and_shows_up_in_the_remote_url() {
        let dir = TempDir::new("rotate");
        // Чужой код из правленого руками конфига считается отсутствующим.
        dir.write_config(r#"{ "remote_token": "чужой" }"#);
        let mut diagnostics = Diagnostics::open(dir.storage()).expect("диагностика");
        diagnostics.normalize();

        let before = diagnostics.remote_token();
        assert_eq!(before.len(), 32);
        assert!(before.chars().all(|ch| ch.is_ascii_hexdigit()));

        let result = diagnostics.rotate_access_code();
        assert_eq!(result["ok"], json!(true));
        let after = diagnostics.remote_token();
        assert_ne!(after, before);
        let url = result["remoteUrl"].as_str().expect("адрес пульта");
        assert!(url.starts_with("http://"), "{url}");
        assert!(url.contains(&after), "{url}");
    }

    /// Оболочка-заглушка: считает вызовы и умеет отклонять хоткей.
    #[derive(Default)]
    struct FakeHud {
        reject_hotkey: AtomicBool,
        toggles: AtomicU64,
        chat_toggles: AtomicU64,
        displays: AtomicU64,
        port_reloads: AtomicU64,
    }

    impl HudHost for FakeHud {
        fn toggle_hud_edit(&self) -> bool {
            self.toggles.fetch_add(1, Ordering::SeqCst);
            true
        }

        fn hud_display_changed(&self) {
            self.displays.fetch_add(1, Ordering::SeqCst);
        }

        fn toggle_chat_hud(&self) {
            self.chat_toggles.fetch_add(1, Ordering::SeqCst);
        }

        fn chat_hud_display_changed(&self) {
            self.displays.fetch_add(1, Ordering::SeqCst);
        }

        fn chat_hud_config_changed(&self) {}

        fn register_hud_hotkey(&self, _hotkey: &str) -> bool {
            !self.reject_hotkey.load(Ordering::SeqCst)
        }

        fn register_chat_hud_hotkey(&self, _hotkey: &str) -> bool {
            !self.reject_hotkey.load(Ordering::SeqCst)
        }

        fn server_port_changed(&self, _previous: u16, _next: u16) {
            self.port_reloads.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn the_hud_edit_flag_is_stored_and_reaches_the_snapshot() {
        use axum::extract::ws::Message;
        use tokio::sync::mpsc;

        let dir = TempDir::new("hud-flag");
        let diagnostics = Diagnostics::open(dir.storage()).expect("диагностика");
        assert_eq!(diagnostics.state_snapshot()["hudEditMode"], json!(false));

        let (tx, mut rx) = mpsc::unbounded_channel();
        diagnostics.clients().add("overlay".to_string(), false, tx);

        diagnostics.set_hud_edit_mode(true);
        assert!(diagnostics.hud_edit_mode());
        assert_eq!(diagnostics.state_snapshot()["hudEditMode"], json!(true));

        // Свежий оверлей узнаёт режим из кадра — как `HUD_EDIT_MODE` в JS.
        let frame = match rx.try_recv() {
            Ok(Message::Text(text)) => text.to_string(),
            other => panic!("ожидался текстовый кадр: {other:?}"),
        };
        let value: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(value["type"], json!(event_types::HUD_EDIT_MODE));
        assert_eq!(value["payload"]["enabled"], json!(true));
    }

    #[test]
    fn the_hud_host_receives_toggles_and_can_reject_a_hotkey() {
        let dir = TempDir::new("hud-host");
        let diagnostics = Diagnostics::open(dir.storage()).expect("диагностика");
        let host = Arc::new(FakeHud::default());
        diagnostics.install_hud(host.clone());

        diagnostics.toggle_hud_edit_mode();
        assert!(diagnostics.hud_edit_mode());
        assert_eq!(host.toggles.load(Ordering::SeqCst), 1);

        diagnostics.toggle_chat_hud();
        assert_eq!(host.chat_toggles.load(Ordering::SeqCst), 1);
        diagnostics.hud_display_changed();
        diagnostics.chat_hud_display_changed();
        assert_eq!(host.displays.load(Ordering::SeqCst), 2);

        // Отказ регистрации хоткея доходит до вызывающего — команда оставит
        // прежнее значение и ответит `ok:false`, как в JS.
        assert!(diagnostics.register_hud_hotkey("Control+Shift+H"));
        host.reject_hotkey.store(true, Ordering::SeqCst);
        assert!(!diagnostics.register_chat_hud_hotkey("Control+Shift+L"));
    }

    #[test]
    fn the_port_reaches_the_shell_and_changes_with_the_listener() {
        let dir = TempDir::new("port-shell");
        let diagnostics = Diagnostics::open(dir.storage()).expect("диагностика");

        // Пока порт не привязан, отдаётся порт из настроек.
        assert_eq!(diagnostics.port(), 8710);

        let host = Arc::new(FakeHud::default());
        diagnostics.install_hud(host.clone());
        diagnostics.server_port_changed(8710, 9000);
        assert_eq!(host.port_reloads.load(Ordering::SeqCst), 1);

        // Привязка к настоящему порту — единый источник и для роутов, и для окон.
        diagnostics.set_port(9000);
        assert_eq!(diagnostics.port(), 9000);
    }

    #[test]
    fn without_a_shell_hotkeys_are_accepted_but_the_window_is_not_toggled() {
        let dir = TempDir::new("hud-none");
        let diagnostics = Diagnostics::open(dir.storage()).expect("диагностика");

        // Нет оболочки — регистрация считается успешной (как отсутствие
        // `onSetHudHotkey` в JS), а окно переключать некому.
        assert!(diagnostics.register_hud_hotkey("Control+Shift+H"));
        diagnostics.toggle_hud_edit_mode();
        assert!(!diagnostics.hud_edit_mode());
    }

    #[test]
    fn config_backup_slots_are_listed_and_restored() {
        use std::fs;

        let dir = TempDir::new("backups");
        dir.write_config(r#"{ "port": 8710, "twitch": { "channel": "old" } }"#);
        let diagnostics = Diagnostics::open(dir.storage()).expect("диагностика");

        // Слот 0 — в том же формате, в каком его пишет атомарный стор.
        let backup = crate::storage::atomic::backup_path(&dir.storage().config_path(), 0);
        fs::write(
            &backup,
            r#"{ "port": 8710, "twitch": { "channel": "restored", "enabled": false } }"#,
        )
        .expect("копия должна записываться");

        let list = diagnostics.list_config_backups();
        assert!(list
            .iter()
            .any(|slot| slot["slot"] == json!(0) && slot["valid"] == json!(true)));

        let result = diagnostics.restore_backup("config", 0);
        assert_eq!(result["ok"], json!(true));
        let channel = {
            let config = diagnostics.config();
            config
                .get("twitch")
                .and_then(|twitch| twitch.get("channel"))
                .cloned()
        };
        assert_eq!(channel, Some(json!("restored")));
    }

    #[test]
    fn restoring_a_config_backup_opens_sealed_secrets_before_saving() {
        use crate::storage::secrets::{labels, SecretStore};
        if !crate::storage::secrets::available() {
            return; // без системного хранилища шифровать нечем
        }

        let dir = TempDir::new("restore-secret");
        dir.write_config(r#"{ "port": 8710, "twitch": { "channel": "old" } }"#);
        let diagnostics = Diagnostics::open(dir.storage()).expect("диагностика");

        // В копии секрет лежит зашифрованным — как его пишет сам стор.
        let sealed = SecretStore::new().seal("ключ-из-копии", labels::TWITCH_CLIENT_SECRET);
        let backup = crate::storage::atomic::backup_path(&dir.storage().config_path(), 0);
        std::fs::write(
            &backup,
            format!(r#"{{ "port": 8710, "twitch": {{ "clientSecret": "{sealed}" }} }}"#),
        )
        .expect("копия должна записываться");

        let result = diagnostics.restore_backup("config", 0);
        assert_eq!(result["ok"], json!(true));

        // Секрет открыт при откате, а не сохранён зашифрованным второй раз.
        let config = diagnostics.config();
        assert_eq!(
            config.get("twitch").unwrap()["clientSecret"],
            json!("ключ-из-копии")
        );
    }

    #[test]
    fn a_missing_backup_or_unknown_target_is_reported() {
        let dir = TempDir::new("backups-missing");
        let diagnostics = Diagnostics::open(dir.storage()).expect("диагностика");

        // Слотов нет — откат не удался, но и не упал.
        for target in ["config", "database"] {
            let result = diagnostics.restore_backup(target, 2);
            assert_eq!(result["ok"], json!(false), "{target}");
            assert!(result["error"].is_string(), "{target}");
        }

        let unknown = diagnostics.restore_backup("nope", 0);
        assert_eq!(unknown["ok"], json!(false));
        assert!(unknown["error"].is_string());
    }

    #[test]
    fn longshot_polling_follows_a_visible_timer_widget() {
        let dir = TempDir::new("longshot");
        let diagnostics = Diagnostics::open(dir.storage()).expect("диагностика");

        // Пустая раскладка — опроса нет.
        assert!(!diagnostics.has_timer_widget());
        assert!(!diagnostics.longshot.is_active());

        // Видимый таймер (2D `timer` и 3D `grimhex-timer` — одна роль).
        for kind in ["timer", "grimhex-timer"] {
            diagnostics
                .database()
                .save_widgets(vec![json!({ "id": "t1", "type": kind })]);
            assert!(diagnostics.has_timer_widget(), "{kind}");
        }

        // Скрытый таймер опрос не держит.
        diagnostics.database().save_widgets(vec![
            json!({ "id": "t1", "type": "timer", "visible": false }),
        ]);
        assert!(!diagnostics.has_timer_widget());

        // Другой виджет — не таймер.
        diagnostics
            .database()
            .save_widgets(vec![json!({ "id": "c1", "type": "chat" })]);
        assert!(!diagnostics.has_timer_widget());

        // Синхронизация на неактивной раскладке в сеть не ходит.
        diagnostics.sync_longshot_activity();
        assert!(!diagnostics.longshot.is_active());
    }
}
