//! OBS WebSocket v5: подпись пароля и план переключения камер.
//!
//! Порт `server/integrations/obs-websocket.js` в части, что только *решает*:
//! подпись пароля (challenge-response), кадр `Identify` на `Hello`, кадр запроса
//! и план переключения ракурсов камеры. Это чистые данные, которые уходят в
//! сокет; сам клиент (подключение, запросы/ответы, события) идёт следом.
//!
//! Протокол: `secret = base64(sha256(пароль + соль))`,
//! `auth = base64(sha256(secret + challenge))`.

use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::storage::history::js_number_or_zero;

/// `base64(sha256(значение))` — в UTF-8, как `crypto.createHash("sha256")`.
pub fn sha256_base64(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(hasher.finalize())
}

/// Подпись для `Hello`: два хеша, как описано в заголовке модуля.
pub fn compute_auth(password: &str, challenge: &str, salt: &str) -> String {
    let secret = sha256_base64(&format!("{password}{salt}"));
    sha256_base64(&format!("{secret}{challenge}"))
}

/// Кадр `Identify` (op 1) на `Hello`.
///
/// Подпись ставится, только если сервер потребовал аутентификацию и пароль задан;
/// без пароля (или без challenge) кадр уходит как есть — как в JS.
pub fn identify_frame(authentication: Option<&Value>, password: &str) -> Value {
    let challenge = authentication
        .and_then(|auth| auth.get("challenge"))
        .and_then(Value::as_str);
    let salt = authentication
        .and_then(|auth| auth.get("salt"))
        .and_then(Value::as_str);
    match (challenge, salt) {
        (Some(challenge), Some(salt)) if !password.is_empty() => json!({
            "op": 1,
            "d": { "rpcVersion": 1, "authentication": compute_auth(password, challenge, salt) },
        }),
        _ => json!({ "op": 1, "d": { "rpcVersion": 1 } }),
    }
}

/// Кадр запроса (op 6).
pub fn request_frame(request_type: &str, request_data: &Value, request_id: &str) -> Value {
    json!({
        "op": 6,
        "d": {
            "requestType": request_type,
            "requestId": request_id,
            "requestData": request_data,
        },
    })
}

/// План переключения ракурса: включить целевой источник, остальные — выключить.
///
/// Ракурсы без `sceneName`/`cameraSource` пропускаются; источники из
/// `exclude_sources` (вебкамера) не трогаются.
pub fn build_camera_switch_plan(
    angles: &Value,
    angle_id: &str,
    exclude_sources: &[String],
) -> Vec<Value> {
    let excluded: std::collections::HashSet<&str> = exclude_sources
        .iter()
        .map(|source| source.trim())
        .filter(|source| !source.is_empty())
        .collect();
    angles
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|angle| {
                    let scene_name = angle
                        .get("sceneName")
                        .and_then(Value::as_str)
                        .filter(|name| !name.is_empty())?;
                    let camera_source = angle
                        .get("cameraSource")
                        .and_then(Value::as_str)
                        .filter(|source| !source.is_empty())?;
                    if excluded.contains(camera_source.trim()) {
                        return None;
                    }
                    Some(json!({
                        "sceneName": scene_name,
                        "cameraSource": camera_source,
                        "enabled": angle.get("id").and_then(Value::as_str) == Some(angle_id),
                    }))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Длительность включённого фильтра: `override` важнее настроенной, отрицательные
/// значения зажимаются в ноль (как `Math.max(0, Number(...) || 0)`).
pub fn resolve_filter_duration(configured: f64, override_seconds: Option<f64>) -> f64 {
    match override_seconds {
        // `override` задан (пусть и нулём) — он побеждает: ноль значит «без таймера».
        Some(value) => js_number_or_zero(Some(&json!(value))).max(0.0),
        None => configured.max(0.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hash_is_base64_of_sha256() {
        // Известное значение: sha256("").
        assert_eq!(
            sha256_base64(""),
            "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="
        );
    }

    #[test]
    fn auth_is_two_hashes() {
        let auth = compute_auth("pass", "challenge", "salt");
        // Формула из документации obs-websocket.
        let secret = sha256_base64("passsalt");
        assert_eq!(auth, sha256_base64(&format!("{secret}challenge")));
    }

    #[test]
    fn identify_carries_a_signature_only_when_needed() {
        let challenge = json!({ "challenge": "c", "salt": "s" });
        let with = identify_frame(Some(&challenge), "pass");
        assert_eq!(with["op"], json!(1));
        assert_eq!(with["d"]["rpcVersion"], json!(1));
        assert_eq!(
            with["d"]["authentication"],
            json!(compute_auth("pass", "c", "s"))
        );

        // Без пароля или без challenge — без подписи.
        assert!(identify_frame(Some(&challenge), "")["d"]["authentication"].is_null());
        assert!(identify_frame(None, "pass")["d"]["authentication"].is_null());
    }

    #[test]
    fn a_request_frame_has_the_v5_shape() {
        let frame = request_frame(
            "SetCurrentProgramScene",
            &json!({ "sceneName": "Main" }),
            "7",
        );
        assert_eq!(frame["op"], json!(6));
        assert_eq!(frame["d"]["requestType"], json!("SetCurrentProgramScene"));
        assert_eq!(frame["d"]["requestId"], json!("7"));
        assert_eq!(frame["d"]["requestData"], json!({ "sceneName": "Main" }));
    }

    #[test]
    fn the_camera_plan_enables_only_the_target() {
        let angles = json!([
            { "id": "cam_main", "sceneName": "Main", "cameraSource": "Cam1" },
            { "id": "cam_side", "sceneName": "Main", "cameraSource": "Cam2" },
            { "id": "broken", "sceneName": "", "cameraSource": "Cam3" },
            { "id": "webcam", "sceneName": "Main", "cameraSource": "Webcam" },
        ]);
        let exclude = vec![" Webcam ".to_string()];
        let plan = build_camera_switch_plan(&angles, "cam_side", &exclude);
        assert_eq!(plan.len(), 2);
        assert_eq!(plan[0]["cameraSource"], json!("Cam1"));
        assert_eq!(plan[0]["enabled"], json!(false));
        assert_eq!(plan[1]["cameraSource"], json!("Cam2"));
        assert_eq!(plan[1]["enabled"], json!(true));
        // Без ракурсов — пустой план.
        assert!(build_camera_switch_plan(&Value::Null, "x", &[]).is_empty());
    }

    #[test]
    fn a_filter_duration_override_wins_and_never_goes_negative() {
        assert_eq!(resolve_filter_duration(5.0, None), 5.0);
        assert_eq!(resolve_filter_duration(5.0, Some(0.0)), 0.0);
        assert_eq!(resolve_filter_duration(5.0, Some(2.0)), 2.0);
        assert_eq!(resolve_filter_duration(-1.0, None), 0.0);
    }
}
