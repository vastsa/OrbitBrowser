use crate::browser::cdp_client::{self, TargetInfo};
use crate::errors::{AppError, AppResult};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

type CdpSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

#[derive(Debug, Clone, PartialEq)]
pub struct GeolocationOverride {
    pub latitude: f64,
    pub longitude: f64,
    pub accuracy: f64,
}

#[derive(Debug, Clone, Default)]
struct RuntimeOverrides {
    timezone_id: Option<String>,
    geolocation: Option<GeolocationOverride>,
}

impl RuntimeOverrides {
    fn new(timezone_id: Option<String>, geolocation: Option<GeolocationOverride>) -> Self {
        Self {
            timezone_id: normalize_timezone_id(timezone_id),
            geolocation,
        }
    }

    fn is_empty(&self) -> bool {
        self.timezone_id.is_none() && self.geolocation.is_none()
    }
}

pub fn spawn(port: u16, timezone_id: Option<String>, geolocation: Option<GeolocationOverride>) {
    let overrides = RuntimeOverrides::new(timezone_id, geolocation);
    if overrides.is_empty() {
        return;
    }

    tokio::spawn(async move {
        if let Err(err) = watch_targets(port, overrides.clone()).await {
            tracing::warn!(
                cdp_port = port,
                error = %err,
                "Failed to apply browser runtime overrides"
            );
        }
    });
}

pub async fn apply_existing(
    port: u16,
    timezone_id: Option<String>,
    geolocation: Option<GeolocationOverride>,
) -> AppResult<()> {
    let overrides = RuntimeOverrides::new(timezone_id, geolocation);
    if overrides.is_empty() {
        return Ok(());
    }
    cdp_client::wait_for_version(port, Duration::from_secs(5)).await?;
    apply_to_existing_targets(port, &overrides, &mut HashSet::new()).await
}

pub async fn grant_geolocation_permission(port: u16, target_url: &str) -> AppResult<()> {
    let mut browser_session = BrowserSession::connect(port).await?;
    browser_session
        .grant_geolocation_permission(target_url)
        .await;
    Ok(())
}

struct TargetSession {
    socket: CdpSocket,
    next_id: u64,
}

struct BrowserSession {
    socket: CdpSocket,
    next_id: u64,
}

impl TargetSession {
    async fn connect(target: &TargetInfo) -> AppResult<Self> {
        let Some(ws_url) = target.web_socket_debugger_url.as_deref() else {
            return Err(AppError::new(
                "cdp_connect_failed",
                "Page target is missing a websocket debugger URL",
            ));
        };
        let (socket, _) = connect_async(ws_url).await.map_err(|err| {
            AppError::new(
                "cdp_connect_failed",
                format!("CDP websocket connection failed: {err}"),
            )
        })?;
        Ok(Self { socket, next_id: 1 })
    }

    async fn set_timezone(&mut self, timezone_id: &str) -> AppResult<()> {
        self.call(
            "Emulation.setTimezoneOverride",
            json!({ "timezoneId": timezone_id }),
        )
        .await
        .map(|_| ())
    }

    async fn set_geolocation(&mut self, geolocation: &GeolocationOverride) -> AppResult<()> {
        self.call(
            "Emulation.setGeolocationOverride",
            json!({
                "latitude": geolocation.latitude,
                "longitude": geolocation.longitude,
                "accuracy": geolocation.accuracy
            }),
        )
        .await
        .map(|_| ())
    }

    async fn call(&mut self, method: &str, params: Value) -> AppResult<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let payload = json!({
            "id": id,
            "method": method,
            "params": params
        });
        self.socket
            .send(Message::Text(payload.to_string().into()))
            .await
            .map_err(|err| {
                AppError::new("cdp_connect_failed", format!("CDP send failed: {err}"))
            })?;

        while let Some(message) = self.socket.next().await {
            let message = message.map_err(|err| {
                AppError::new("cdp_connect_failed", format!("CDP read failed: {err}"))
            })?;
            let Message::Text(text) = message else {
                continue;
            };
            let value: Value = serde_json::from_str(&text)?;
            if value.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(error) = value.get("error") {
                    return Err(AppError::new(
                        "cdp_connect_failed",
                        format!("CDP method failed: {method}"),
                    )
                    .details(error.clone()));
                }
                return Ok(value.get("result").cloned().unwrap_or(Value::Null));
            }
        }

        Err(AppError::new(
            "cdp_connect_failed",
            "CDP connection is closed",
        ))
    }
}

impl BrowserSession {
    async fn connect(port: u16) -> AppResult<Self> {
        let version = cdp_client::wait_for_version(port, Duration::from_secs(5)).await?;
        let ws_url = version.websocket_debugger_url.ok_or_else(|| {
            AppError::new(
                "cdp_connect_failed",
                "Browser target is missing a websocket debugger URL",
            )
        })?;
        let (socket, _) = connect_async(ws_url).await.map_err(|err| {
            AppError::new(
                "cdp_connect_failed",
                format!("CDP browser websocket connection failed: {err}"),
            )
        })?;
        Ok(Self { socket, next_id: 1 })
    }

    async fn grant_geolocation_permission(&mut self, target_url: &str) {
        let mut params = json!({ "permissions": ["geolocation"] });
        if let Some(origin) = target_origin(target_url) {
            params["origin"] = json!(origin);
        }
        if let Err(err) = self.call("Browser.grantPermissions", params).await {
            tracing::warn!(
                target_url,
                error = %err,
                "Failed to grant geolocation permission"
            );
        }
    }

    async fn call(&mut self, method: &str, params: Value) -> AppResult<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let payload = json!({
            "id": id,
            "method": method,
            "params": params
        });
        self.socket
            .send(Message::Text(payload.to_string().into()))
            .await
            .map_err(|err| {
                AppError::new("cdp_connect_failed", format!("CDP send failed: {err}"))
            })?;

        while let Some(message) = self.socket.next().await {
            let message = message.map_err(|err| {
                AppError::new("cdp_connect_failed", format!("CDP read failed: {err}"))
            })?;
            let Message::Text(text) = message else {
                continue;
            };
            let value: Value = serde_json::from_str(&text)?;
            if value.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(error) = value.get("error") {
                    return Err(AppError::new(
                        "cdp_connect_failed",
                        format!("CDP method failed: {method}"),
                    )
                    .details(error.clone()));
                }
                return Ok(value.get("result").cloned().unwrap_or(Value::Null));
            }
        }

        Err(AppError::new(
            "cdp_connect_failed",
            "CDP connection is closed",
        ))
    }
}

async fn watch_targets(port: u16, overrides: RuntimeOverrides) -> AppResult<()> {
    let mut applied_target_ids = HashSet::new();
    let mut consecutive_errors = 0;

    loop {
        match apply_to_existing_targets(port, &overrides, &mut applied_target_ids).await {
            Ok(()) => {
                consecutive_errors = 0;
            }
            Err(err) => {
                consecutive_errors += 1;
                if consecutive_errors >= 5 || !cdp_client::ping(port).await {
                    return Err(err);
                }
                tracing::warn!(
                    cdp_port = port,
                    error = %err,
                    "Failed to refresh runtime override targets"
                );
            }
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

async fn apply_to_existing_targets(
    port: u16,
    overrides: &RuntimeOverrides,
    applied_target_ids: &mut HashSet<String>,
) -> AppResult<()> {
    let targets = cdp_client::list_targets(port).await?;
    let pending_targets = targets
        .iter()
        .filter(|target| supports_timezone_override(target))
        .filter(|target| {
            overrides.geolocation.is_some()
                || !applied_target_ids.contains(&target_apply_key(target))
        })
        .collect::<Vec<_>>();
    let mut browser_session = if overrides.geolocation.is_some() && !pending_targets.is_empty() {
        Some(BrowserSession::connect(port).await?)
    } else {
        None
    };
    for target in pending_targets {
        match TargetSession::connect(target).await {
            Ok(mut session) => {
                let apply_key = target_apply_key(target);
                let first_apply = !applied_target_ids.contains(&apply_key);
                if first_apply {
                    if let Some(timezone_id) = overrides.timezone_id.as_deref() {
                        if let Err(err) = session.set_timezone(timezone_id).await {
                            tracing::warn!(
                                target_id = target.id,
                                target_url = target.url,
                                error = %err,
                                "Failed to apply timezone override"
                            );
                        }
                    }
                }
                if let Some(geolocation) = overrides.geolocation.as_ref() {
                    if let Some(browser_session) = browser_session.as_mut() {
                        browser_session
                            .grant_geolocation_permission(&target.url)
                            .await;
                    }
                    if let Err(err) = session.set_geolocation(geolocation).await {
                        tracing::warn!(
                            target_id = target.id,
                            target_url = target.url,
                            error = %err,
                            "Failed to apply geolocation override"
                        );
                    }
                }
                applied_target_ids.insert(apply_key);
            }
            Err(err) => {
                tracing::warn!(
                    target_id = target.id,
                    target_url = target.url,
                    error = %err,
                    "Failed to connect target for timezone override"
                );
            }
        }
    }

    Ok(())
}

fn normalize_timezone_id(timezone_id: Option<String>) -> Option<String> {
    timezone_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn supports_timezone_override(target: &TargetInfo) -> bool {
    matches!(target.kind.as_str(), "page" | "iframe")
}

fn target_apply_key(target: &TargetInfo) -> String {
    format!("{}:{}", target.id, target.url)
}

fn target_origin(target_url: &str) -> Option<String> {
    let url = reqwest::Url::parse(target_url).ok()?;
    match url.scheme() {
        "http" | "https" => {}
        _ => return None,
    }
    let host = url.host_str()?;
    let port = url
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    Some(format!("{}://{}{}", url.scheme(), host, port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_timezone_is_ignored() {
        assert_eq!(normalize_timezone_id(None), None);
        assert_eq!(normalize_timezone_id(Some("  ".to_string())), None);
    }

    #[test]
    fn timezone_is_trimmed() {
        assert_eq!(
            normalize_timezone_id(Some(" Asia/Tokyo ".to_string())),
            Some("Asia/Tokyo".to_string())
        );
    }

    #[test]
    fn only_page_like_targets_receive_timezone_override() {
        let page = TargetInfo {
            id: "page-1".to_string(),
            kind: "page".to_string(),
            title: String::new(),
            url: String::new(),
            web_socket_debugger_url: None,
        };
        let service_worker = TargetInfo {
            kind: "service_worker".to_string(),
            ..page.clone()
        };

        assert!(supports_timezone_override(&page));
        assert!(!supports_timezone_override(&service_worker));
    }

    #[test]
    fn extracts_http_origin_for_permission_grant() {
        assert_eq!(
            target_origin("https://www.browserscan.net/zh"),
            Some("https://www.browserscan.net".to_string())
        );
        assert_eq!(target_origin("about:blank"), None);
    }
}
