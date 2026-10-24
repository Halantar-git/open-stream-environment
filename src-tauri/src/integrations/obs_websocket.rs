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

/// Роли сцен, которые настраиваются в OBS одной кнопкой: роль, имя источника
/// в OBS и путь страницы. Порядок — порядок создания.
///
/// Имена источников постоянные и на латинице: по ним повторный запуск узнаёт
/// уже созданный источник и не плодит дубликаты.
pub const SETUP_SOURCES: [(&str, &str, &str); 9] = [
    ("main", "OSE Overlay", "/overlay/overlay.html"),
    ("start", "OSE Start", "/overlay/scene.html?type=start"),
    ("brb", "OSE BRB", "/overlay/scene.html?type=brb"),
    ("talk", "OSE Talk", "/overlay/scene.html?type=talk"),
    ("pause", "OSE Pause", "/overlay/scene.html?type=pause"),
    ("end", "OSE End", "/overlay/scene.html?type=end"),
    ("wheel", "OSE Wheel", "/overlay/wheel-scene.html"),
    ("poll", "OSE Poll", "/overlay/poll-scene.html"),
    ("video", "OSE Opening", "/overlay/video-splash.html"),
];

/// Имя сцены по умолчанию, если словаря интерфейса нет под рукой.
pub fn default_scene_name(role: &str) -> &'static str {
    match role {
        "main" => "Основной",
        "start" => "Старт",
        "brb" => "Перерыв",
        "talk" => "Разговор",
        "pause" => "Пауза",
        "end" => "Конец",
        "wheel" => "Колесо",
        "poll" => "Голосование",
        "video" => "Заставка",
        _ => "",
    }
}

/// План настройки сцен OBS.
///
/// `scene_map` из настроек важнее `defaults`: пользователь мог переименовать
/// сцены у себя. Ничего не удаляем и не переименовываем — только создаём
/// недостающее. Одна сцена на две роли (ошибка в маппинге) попадает в план
/// один раз: OBS не хранит две сцены с одним именем.
pub fn build_setup_plan(
    scene_map: &Value,
    defaults: &Value,
    port: u16,
    existing_scenes: &[String],
    existing_inputs: &[String],
) -> Vec<Value> {
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    SETUP_SOURCES
        .iter()
        .filter_map(|(role, source_name, path)| {
            let name = scene_name(scene_map, role)
                .or_else(|| scene_name(defaults, role))
                .unwrap_or_else(|| default_scene_name(role).to_string());
            if name.is_empty() || !used.insert(name.clone()) {
                return None;
            }
            Some(json!({
                "role": role,
                "sceneName": name,
                "sourceName": source_name,
                "url": format!("http://localhost:{port}{path}"),
                "createScene": !existing_scenes.iter().any(|scene| scene == &name),
                "createSource": !existing_inputs.iter().any(|input| input == source_name),
            }))
        })
        .collect()
}

/// Непустое имя сцены из объекта по роли.
fn scene_name(map: &Value, role: &str) -> Option<String> {
    map.get(role)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
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

    #[test]
    fn the_setup_plan_creates_only_what_is_missing() {
        let defaults = json!({ "main": "Main", "start": "Start" });
        let plan = build_setup_plan(
            &json!({}),
            &defaults,
            8710,
            &["Main".to_string()],
            &["OSE Start".to_string()],
        );
        // Все девять ролей в плане: даже существующие нужны, чтобы переключение
        // сцен работало и адрес источника был актуальным.
        assert_eq!(plan.len(), SETUP_SOURCES.len());

        let main = &plan[0];
        assert_eq!(main["sceneName"], json!("Main"));
        assert_eq!(main["createScene"], json!(false));
        assert_eq!(main["createSource"], json!(true));

        let start = &plan[1];
        assert_eq!(start["createScene"], json!(true));
        assert_eq!(start["createSource"], json!(false));
    }

    #[test]
    fn the_setup_plan_prefers_the_configured_scene_names() {
        let plan = build_setup_plan(
            &json!({ "main": "  Моя игра  ", "brb": "" }),
            &json!({ "main": "Main", "brb": "Перерыв" }),
            9000,
            &[],
            &[],
        );
        let main = &plan[0];
        assert_eq!(main["sceneName"], json!("Моя игра"));
        // Пустое поле в настройках — не имя: берём умолчание.
        let brb = &plan[2];
        assert_eq!(brb["sceneName"], json!("Перерыв"));
    }

    #[test]
    fn the_setup_plan_maps_each_role_to_its_own_page() {
        let plan = build_setup_plan(&json!({}), &json!({}), 8710, &[], &[]);
        let url = |role: &str| {
            plan.iter()
                .find(|step| step["role"] == json!(role))
                .map(|step| step["url"].as_str().unwrap_or_default().to_string())
                .unwrap_or_default()
        };
        assert_eq!(url("main"), "http://localhost:8710/overlay/overlay.html");
        assert_eq!(
            url("start"),
            "http://localhost:8710/overlay/scene.html?type=start"
        );
        assert_eq!(
            url("wheel"),
            "http://localhost:8710/overlay/wheel-scene.html"
        );
        assert_eq!(url("poll"), "http://localhost:8710/overlay/poll-scene.html");
        assert_eq!(
            url("video"),
            "http://localhost:8710/overlay/video-splash.html"
        );
    }

    #[test]
    fn the_setup_plan_does_not_repeat_a_scene() {
        // Две роли на одно имя: OBS не создаст вторую сцену, и план не должен
        // обещать этого — иначе второй шаг всегда кончался бы ошибкой.
        let plan = build_setup_plan(
            &json!({ "main": "Сцена", "talk": "Сцена" }),
            &json!({}),
            8710,
            &[],
            &[],
        );
        assert_eq!(
            plan.iter()
                .filter(|step| step["sceneName"] == json!("Сцена"))
                .count(),
            1
        );
    }
}
