//! Конкретный транспорт чата Twitch: WebSocket на `tokio-tungstenite`.
//!
//! Отдельно от [`crate::integrations::twitch_chat`], где живёт протокол: там
//! транспорт инжектируется и проверяется каналом, здесь — настоящий сокет. Так
//! протокол не тянет сеть в тесты, а сокет остаётся тонким адаптером.
//!
//! TLS для `wss` включён: зависимость собрана с фичей `native-tls` (на Windows —
//! schannel, без OpenSSL), поэтому `connect_async` открывает
//! `wss://irc-ws.chat.twitch.tv` как есть.

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use crate::integrations::twitch_chat::{ChatTransport, ConnectFuture, RecvFuture, SendFuture};

/// Подключиться к IRC-чату по WebSocket. Ошибка — текст, как и у остальных
/// сетевых путей: вызывающий (драйвер) сообщает о ней статусом, а не паникой.
pub fn websocket_connect(url: String) -> ConnectFuture {
    websocket_connect_with_headers(url, Vec::new())
}

/// То же, но с заголовками запроса — для сервисов, которые их проверяют
/// (DonationAlerts/Centrifugo). Заголовок с недопустимым значением пропускаем:
/// остальные всё равно полезны.
pub fn websocket_connect_with_headers(
    url: String,
    headers: Vec<(&'static str, &'static str)>,
) -> ConnectFuture {
    Box::pin(async move {
        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|error| error.to_string())?;
        for (name, value) in headers {
            if let Ok(value) = HeaderValue::from_str(value) {
                request.headers_mut().insert(name, value);
            }
        }
        let (stream, _response) = connect_async(request)
            .await
            .map_err(|error| error.to_string())?;
        Ok(Box::new(WebSocketTransport { stream }) as Box<dyn ChatTransport>)
    })
}

/// Заголовки подключения к Centrifugo DonationAlerts — те же, что ставит браузер
/// в JS (`Origin` и `User-Agent`).
const DA_ORIGIN: &str = "https://www.donationalerts.com";
const DA_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/// Подключение к сокету DonationAlerts.
pub fn donationalerts_connect(url: String) -> ConnectFuture {
    websocket_connect_with_headers(
        url,
        vec![("Origin", DA_ORIGIN), ("User-Agent", DA_USER_AGENT)],
    )
}

/// Сокет чата: текстовые кадры — строки IRC, бинарные — тоже текст (Twitch
/// всегда шлёт текст, но на всякий случай декодируем без потерь).
struct WebSocketTransport {
    stream: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

impl ChatTransport for WebSocketTransport {
    fn send(&mut self, line: String) -> SendFuture<'_> {
        Box::pin(async move {
            self.stream
                .send(Message::Text(line.into()))
                .await
                .map_err(|error| error.to_string())
        })
    }

    fn recv(&mut self) -> RecvFuture<'_> {
        Box::pin(async move {
            match self.stream.next().await {
                Some(Ok(Message::Text(text))) => Ok(Some(text.as_str().to_string())),
                Some(Ok(Message::Binary(bytes))) => {
                    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
                }
                // Закрытие соединения — это `None`, а не ошибка: драйвер отличит
                // штатный разрыв от сбоя и скажет панели разное.
                Some(Ok(Message::Close(_))) | None => Ok(None),
                // Ping/Pong/Frame не несут строк IRC; отдаём пустой кадр, который
                // разбор пропустит. На `PING` Twitch отвечает сам tungstenite.
                Some(Ok(_)) => Ok(Some(String::new())),
                Some(Err(error)) => Err(error.to_string()),
            }
        })
    }
}
