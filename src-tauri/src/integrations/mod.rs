//! Интеграции со стрим-сервисами.
//!
//! Порт `server/integrations/`. Сеть здесь не трогается: сначала переносятся
//! части, которые только *решают*, — их можно проверить без сокетов и записанных
//! фикстур. Так сделана модерация чата ([`chat_moderation`]) и будет чат-бот.

pub mod chat_bot;
pub mod chat_bot_control;
pub mod chat_moderation;
pub mod donationalerts;
pub mod donationalerts_control;
pub mod http;
pub mod longshot_sync;
pub mod nick_color;
pub mod obs_websocket;
pub mod obs_websocket_control;
pub mod token_refresh;
pub mod twitch_badges;
pub mod twitch_chat;
pub mod twitch_chat_control;
pub mod twitch_chat_socket;
pub mod twitch_eventsub;
pub mod twitch_eventsub_control;
pub mod twitch_helix;
pub mod youtube_live;
pub mod youtube_live_control;
