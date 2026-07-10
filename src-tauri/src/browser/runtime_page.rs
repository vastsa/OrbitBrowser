use crate::browser::cdp_client::{CdpPage, PageSnapshot};
use crate::domain::agent::AgentRecordingEvent;
use crate::domain::browser_context::BrowserContextSnapshot;
use crate::errors::{AppError, AppResult};
use base64::Engine;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::time::Duration;

pub enum BrowserPage {
    Cdp(CdpPage),
    Camoufox(CamoufoxPage),
}

pub struct CamoufoxPage {
    control_port: u16,
    client: reqwest::Client,
}

impl BrowserPage {
    pub async fn connect_cdp(port: u16, start_url: Option<&str>) -> AppResult<Self> {
        Ok(Self::Cdp(CdpPage::connect(port, start_url).await?))
    }

    pub async fn connect_camoufox(control_port: u16) -> AppResult<Self> {
        let page = CamoufoxPage::connect(control_port).await?;
        Ok(Self::Camoufox(page))
    }

    pub async fn goto(&mut self, url: &str, timeout: Duration) -> AppResult<()> {
        match self {
            Self::Cdp(page) => page.goto(url, timeout).await,
            Self::Camoufox(page) => page.goto(url, timeout).await,
        }
    }

    pub async fn set_timezone_override(&mut self, timezone_id: &str) -> AppResult<()> {
        match self {
            Self::Cdp(page) => page.set_timezone_override(timezone_id).await,
            Self::Camoufox(page) => page.set_timezone_override(timezone_id).await,
        }
    }

    pub async fn set_geolocation_override(
        &mut self,
        latitude: f64,
        longitude: f64,
        accuracy: f64,
    ) -> AppResult<()> {
        match self {
            Self::Cdp(page) => {
                page.set_geolocation_override(latitude, longitude, accuracy)
                    .await
            }
            Self::Camoufox(page) => {
                page.set_geolocation_override(latitude, longitude, accuracy)
                    .await
            }
        }
    }

    pub async fn evaluate(&mut self, expression: &str) -> AppResult<Value> {
        match self {
            Self::Cdp(page) => page.evaluate(expression).await,
            Self::Camoufox(page) => page.evaluate(expression).await,
        }
    }

    pub async fn click(&mut self, selector: &str) -> AppResult<()> {
        match self {
            Self::Cdp(page) => page.click(selector).await,
            Self::Camoufox(page) => page.click(selector).await,
        }
    }

    pub async fn mouse_click(&mut self, x: f64, y: f64, button: &str) -> AppResult<()> {
        match self {
            Self::Cdp(page) => page.mouse_click(x, y, button).await,
            Self::Camoufox(page) => page.mouse_click(x, y, button).await,
        }
    }

    pub async fn type_text(&mut self, selector: &str, text: &str) -> AppResult<()> {
        match self {
            Self::Cdp(page) => page.type_text(selector, text).await,
            Self::Camoufox(page) => page.type_text(selector, text).await,
        }
    }

    pub async fn wait_for_selector(&mut self, selector: &str, timeout: Duration) -> AppResult<()> {
        match self {
            Self::Cdp(page) => page.wait_for_selector(selector, timeout).await,
            Self::Camoufox(page) => page.wait_for_selector(selector, timeout).await,
        }
    }

    pub async fn title(&mut self) -> AppResult<String> {
        match self {
            Self::Cdp(page) => page.title().await,
            Self::Camoufox(page) => page.title().await,
        }
    }

    pub async fn url(&mut self) -> AppResult<String> {
        match self {
            Self::Cdp(page) => page.url().await,
            Self::Camoufox(page) => page.url().await,
        }
    }

    pub async fn snapshot(&mut self) -> AppResult<PageSnapshot> {
        match self {
            Self::Cdp(page) => page.snapshot().await,
            Self::Camoufox(page) => Ok(PageSnapshot {
                title: page.title().await?,
                url: page.url().await?,
            }),
        }
    }

    pub async fn context_snapshot(
        &mut self,
        include_screenshot: bool,
    ) -> AppResult<BrowserContextSnapshot> {
        match self {
            Self::Cdp(page) => page.context_snapshot(include_screenshot).await,
            Self::Camoufox(page) => page.context_snapshot(include_screenshot).await,
        }
    }

    pub async fn screenshot_png(&mut self) -> AppResult<Vec<u8>> {
        match self {
            Self::Cdp(page) => page.screenshot_png().await,
            Self::Camoufox(page) => page.screenshot_png().await,
        }
    }

    pub async fn next_recording_event(
        &mut self,
        timeout: Duration,
    ) -> AppResult<Option<AgentRecordingEvent>> {
        match self {
            Self::Cdp(page) => page.next_recording_event(timeout).await,
            Self::Camoufox(page) => page.next_recording_event(timeout).await,
        }
    }
}

impl CamoufoxPage {
    async fn connect(control_port: u16) -> AppResult<Self> {
        let page = Self {
            control_port,
            client: reqwest::Client::new(),
        };
        page.health().await?;
        Ok(page)
    }

    async fn health(&self) -> AppResult<()> {
        self.client
            .get(format!("http://127.0.0.1:{}/health", self.control_port))
            .timeout(Duration::from_secs(2))
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    async fn rpc<T: DeserializeOwned>(&self, action: &str, params: Value) -> AppResult<T> {
        let response = self
            .client
            .post(format!("http://127.0.0.1:{}/rpc", self.control_port))
            .json(&json!({ "action": action, "params": params }))
            .timeout(Duration::from_secs(95))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        if response.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(AppError::new(
                "camoufox_rpc_failed",
                response
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Camoufox command failed"),
            ));
        }
        serde_json::from_value(response.get("value").cloned().unwrap_or(Value::Null))
            .map_err(AppError::from)
    }

    pub async fn goto(&self, url: &str, timeout: Duration) -> AppResult<()> {
        self.rpc::<()>(
            "goto",
            json!({ "url": url, "timeout_ms": timeout.as_millis() as u64 }),
        )
        .await
    }

    pub async fn set_timezone_override(&self, timezone_id: &str) -> AppResult<()> {
        self.rpc::<()>("set_timezone", json!({ "timezone_id": timezone_id }))
            .await
    }

    pub async fn set_geolocation_override(
        &self,
        latitude: f64,
        longitude: f64,
        accuracy: f64,
    ) -> AppResult<()> {
        self.rpc::<()>(
            "set_geolocation",
            json!({ "latitude": latitude, "longitude": longitude, "accuracy": accuracy }),
        )
        .await
    }

    pub async fn evaluate(&self, expression: &str) -> AppResult<Value> {
        self.rpc("evaluate", json!({ "expression": expression }))
            .await
    }

    pub async fn click(&self, selector: &str) -> AppResult<()> {
        self.rpc("click", json!({ "selector": selector })).await
    }

    pub async fn mouse_click(&self, x: f64, y: f64, button: &str) -> AppResult<()> {
        self.rpc("mouse_click", json!({ "x": x, "y": y, "button": button }))
            .await
    }

    pub async fn type_text(&self, selector: &str, text: &str) -> AppResult<()> {
        self.rpc("type_text", json!({ "selector": selector, "text": text }))
            .await
    }

    pub async fn wait_for_selector(&self, selector: &str, timeout: Duration) -> AppResult<()> {
        self.rpc(
            "wait_for_selector",
            json!({ "selector": selector, "timeout_ms": timeout.as_millis() as u64 }),
        )
        .await
    }

    pub async fn title(&self) -> AppResult<String> {
        self.rpc("title", json!({})).await
    }

    pub async fn url(&self) -> AppResult<String> {
        self.rpc("url", json!({})).await
    }

    pub async fn screenshot_png(&self) -> AppResult<Vec<u8>> {
        let data = self.rpc::<String>("screenshot_png", json!({})).await?;
        base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|err| {
                AppError::new(
                    "camoufox_rpc_failed",
                    format!("Screenshot base64 decode failed: {err}"),
                )
            })
    }

    pub async fn context_snapshot(
        &self,
        include_screenshot: bool,
    ) -> AppResult<BrowserContextSnapshot> {
        self.rpc(
            "context_snapshot",
            json!({ "include_screenshot": include_screenshot }),
        )
        .await
    }

    pub async fn next_recording_event(
        &self,
        timeout: Duration,
    ) -> AppResult<Option<AgentRecordingEvent>> {
        let mut event = self
            .rpc::<Option<AgentRecordingEvent>>(
                "next_recording_event",
                json!({ "timeout_ms": timeout.as_millis() as u64 }),
            )
            .await?;
        if let Some(event) = &mut event {
            event.timestamp = chrono::Utc::now().to_rfc3339();
        }
        Ok(event)
    }
}

pub async fn camoufox_ping(control_port: u16) -> bool {
    CamoufoxPage {
        control_port,
        client: reqwest::Client::new(),
    }
    .health()
    .await
    .is_ok()
}
