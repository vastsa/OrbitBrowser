use crate::domain::browser_context::{
    BrowserConsoleEntry, BrowserContextSnapshot, BrowserInteractiveElement, BrowserNetworkEntry,
};
use crate::errors::{AppError, AppResult};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct CdpVersion {
    pub browser: Option<String>,
    #[serde(rename = "webSocketDebuggerUrl")]
    pub websocket_debugger_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetInfo {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub title: String,
    pub url: String,
    #[serde(rename = "webSocketDebuggerUrl")]
    pub web_socket_debugger_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PageSnapshot {
    pub title: String,
    pub url: String,
}

type CdpSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

pub struct CdpPage {
    socket: CdpSocket,
    next_id: u64,
    recent_console_entries: Vec<BrowserConsoleEntry>,
    recent_network_entries: Vec<BrowserNetworkEntry>,
}

pub async fn wait_for_version(port: u16, timeout: Duration) -> AppResult<CdpVersion> {
    let url = version_url(port);
    let client = reqwest::Client::new();
    let deadline = Instant::now() + timeout;
    let mut last_error = None;

    while Instant::now() < deadline {
        match client
            .get(&url)
            .timeout(Duration::from_millis(500))
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                let value = response.json::<CdpVersion>().await?;
                return Ok(value);
            }
            Ok(response) => {
                last_error = Some(format!("HTTP {}", response.status()));
            }
            Err(err) => {
                last_error = Some(err.to_string());
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    Err(
        AppError::new("cdp_timeout", "Timed out waiting for Chrome CDP port")
            .details(json!({ "port": port, "lastError": last_error }))
            .retryable(true),
    )
}

pub async fn ping(port: u16) -> bool {
    reqwest::Client::new()
        .get(version_url(port))
        .timeout(Duration::from_millis(700))
        .send()
        .await
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

pub async fn list_targets(port: u16) -> AppResult<Vec<TargetInfo>> {
    let url = format!("http://127.0.0.1:{port}/json/list");
    let targets = reqwest::Client::new()
        .get(url)
        .timeout(Duration::from_secs(3))
        .send()
        .await?
        .error_for_status()?
        .json::<Vec<TargetInfo>>()
        .await?;
    Ok(targets)
}

pub async fn open_or_first_page(port: u16, start_url: Option<&str>) -> AppResult<TargetInfo> {
    let targets = list_targets(port).await.unwrap_or_default();
    if let Some(target) = targets
        .iter()
        .find(|target| target.kind == "page" && target.web_socket_debugger_url.is_some())
    {
        return Ok(target.clone());
    }

    let url = start_url.unwrap_or("about:blank");
    let endpoint = format!("http://127.0.0.1:{port}/json/new?{url}");
    let target = reqwest::Client::new()
        .put(endpoint)
        .timeout(Duration::from_secs(3))
        .send()
        .await?
        .error_for_status()?
        .json::<TargetInfo>()
        .await?;
    Ok(target)
}

impl CdpPage {
    pub async fn connect(port: u16, start_url: Option<&str>) -> AppResult<Self> {
        let target = open_or_first_page(port, start_url).await?;
        let Some(ws_url) = target.web_socket_debugger_url.clone() else {
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
        let mut page = Self {
            socket,
            next_id: 1,
            recent_console_entries: Vec::new(),
            recent_network_entries: Vec::new(),
        };
        page.call("Page.enable", json!({})).await?;
        page.call("Runtime.enable", json!({})).await?;
        page.call("Network.enable", json!({})).await?;
        Ok(page)
    }

    pub async fn goto(&mut self, url: &str, timeout: Duration) -> AppResult<()> {
        self.call("Page.navigate", json!({ "url": url })).await?;
        self.wait_event("Page.loadEventFired", timeout).await
    }

    pub async fn navigate_without_wait(&mut self, url: &str) -> AppResult<()> {
        self.call("Page.navigate", json!({ "url": url }))
            .await
            .map(|_| ())
    }

    pub async fn set_timezone_override(&mut self, timezone_id: &str) -> AppResult<()> {
        self.call(
            "Emulation.setTimezoneOverride",
            json!({ "timezoneId": timezone_id }),
        )
        .await
        .map(|_| ())
    }

    pub async fn set_geolocation_override(
        &mut self,
        latitude: f64,
        longitude: f64,
        accuracy: f64,
    ) -> AppResult<()> {
        self.call(
            "Emulation.setGeolocationOverride",
            json!({
                "latitude": latitude,
                "longitude": longitude,
                "accuracy": accuracy
            }),
        )
        .await
        .map(|_| ())
    }

    pub async fn evaluate(&mut self, expression: &str) -> AppResult<Value> {
        let response = self
            .call(
                "Runtime.evaluate",
                json!({
                    "expression": expression,
                    "returnByValue": true,
                    "awaitPromise": true
                }),
            )
            .await?;
        if let Some(exception) = response.get("exceptionDetails") {
            return Err(
                AppError::new("script_runtime_error", "Page expression execution failed")
                    .details(exception.clone()),
            );
        }
        Ok(response
            .pointer("/result/value")
            .cloned()
            .unwrap_or(Value::Null))
    }

    pub async fn click(&mut self, selector: &str) -> AppResult<()> {
        let selector_json = serde_json::to_string(selector)?;
        let expression = format!(
            r#"
(() => {{
  const el = document.querySelector({selector_json});
  if (!el) throw new Error("selector not found: " + {selector_json});
  el.scrollIntoView({{ block: "center", inline: "center" }});
  el.click();
  return true;
}})()
"#
        );
        self.evaluate(&expression).await?;
        Ok(())
    }

    pub async fn mouse_click(&mut self, x: f64, y: f64, button: &str) -> AppResult<()> {
        let button = match button {
            "middle" => "middle",
            "right" => "right",
            _ => "left",
        };
        self.call(
            "Input.dispatchMouseEvent",
            json!({
                "type": "mouseMoved",
                "x": x,
                "y": y,
                "button": "none"
            }),
        )
        .await?;
        self.call(
            "Input.dispatchMouseEvent",
            json!({
                "type": "mousePressed",
                "x": x,
                "y": y,
                "button": button,
                "clickCount": 1
            }),
        )
        .await?;
        self.call(
            "Input.dispatchMouseEvent",
            json!({
                "type": "mouseReleased",
                "x": x,
                "y": y,
                "button": button,
                "clickCount": 1
            }),
        )
        .await?;
        Ok(())
    }

    pub async fn type_text(&mut self, selector: &str, text: &str) -> AppResult<()> {
        let selector_json = serde_json::to_string(selector)?;
        let text_json = serde_json::to_string(text)?;
        let expression = format!(
            r#"
(() => {{
  const el = document.querySelector({selector_json});
  if (!el) throw new Error("selector not found: " + {selector_json});
  el.focus();
  el.value = {text_json};
  el.dispatchEvent(new Event("input", {{ bubbles: true }}));
  el.dispatchEvent(new Event("change", {{ bubbles: true }}));
  return true;
}})()
"#
        );
        self.evaluate(&expression).await?;
        Ok(())
    }

    pub async fn wait_for_selector(&mut self, selector: &str, timeout: Duration) -> AppResult<()> {
        let selector_json = serde_json::to_string(selector)?;
        let expression = format!(
            r#"
new Promise((resolve, reject) => {{
  const selector = {selector_json};
  if (document.querySelector(selector)) {{
    resolve(true);
    return;
  }}
  const observer = new MutationObserver(() => {{
    if (document.querySelector(selector)) {{
      observer.disconnect();
      resolve(true);
    }}
  }});
  observer.observe(document.documentElement, {{ childList: true, subtree: true }});
  setTimeout(() => {{
    observer.disconnect();
    reject(new Error("selector timeout: " + selector));
  }}, {timeout_ms});
}})
"#,
            timeout_ms = timeout.as_millis()
        );
        self.evaluate(&expression).await?;
        Ok(())
    }

    pub async fn title(&mut self) -> AppResult<String> {
        let value = self.evaluate("document.title").await?;
        Ok(value.as_str().unwrap_or_default().to_string())
    }

    pub async fn url(&mut self) -> AppResult<String> {
        let value = self.evaluate("location.href").await?;
        Ok(value.as_str().unwrap_or_default().to_string())
    }

    pub async fn snapshot(&mut self) -> AppResult<PageSnapshot> {
        Ok(PageSnapshot {
            title: self.title().await?,
            url: self.url().await?,
        })
    }

    pub async fn context_snapshot(
        &mut self,
        include_screenshot: bool,
    ) -> AppResult<BrowserContextSnapshot> {
        let title = self.title().await?;
        let url = self.url().await?;
        let value = self.evaluate(browser_context_script()).await?;
        let interactive_elements = serde_json::from_value::<Vec<BrowserInteractiveElement>>(
            value
                .get("interactiveElements")
                .cloned()
                .unwrap_or_else(|| Value::Array(Vec::new())),
        )
        .unwrap_or_default();
        let screenshot_base64 = if include_screenshot {
            Some(base64::engine::general_purpose::STANDARD.encode(self.screenshot_png().await?))
        } else {
            None
        };

        Ok(BrowserContextSnapshot {
            url,
            title,
            screenshot_base64,
            html_excerpt: value
                .get("htmlExcerpt")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            visible_text: value
                .get("visibleText")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            interactive_elements,
            console_entries: self.recent_console_entries.clone(),
            network_entries: self.recent_network_entries.clone(),
        })
    }

    pub async fn screenshot_png(&mut self) -> AppResult<Vec<u8>> {
        let response = self
            .call(
                "Page.captureScreenshot",
                json!({ "format": "png", "captureBeyondViewport": true }),
            )
            .await?;
        let data = response
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AppError::new("cdp_connect_failed", "Screenshot response is missing data")
            })?;
        base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|err| {
                AppError::new(
                    "cdp_connect_failed",
                    format!("Screenshot base64 decode failed: {err}"),
                )
            })
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
            self.record_event(&value);
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

    async fn wait_event(&mut self, event_name: &str, timeout: Duration) -> AppResult<()> {
        let deadline = Instant::now() + timeout;
        loop {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return Err(AppError::new(
                    "cdp_timeout",
                    format!("Timed out waiting for CDP event: {event_name}"),
                )
                .retryable(true));
            };
            let Some(message) = tokio::time::timeout(remaining, self.socket.next())
                .await
                .map_err(|_| {
                    AppError::new(
                        "cdp_timeout",
                        format!("Timed out waiting for CDP event: {event_name}"),
                    )
                })?
            else {
                return Err(AppError::new(
                    "cdp_connect_failed",
                    "CDP connection is closed",
                ));
            };
            let message = message.map_err(|err| {
                AppError::new("cdp_connect_failed", format!("CDP read failed: {err}"))
            })?;
            let Message::Text(text) = message else {
                continue;
            };
            let value: Value = serde_json::from_str(&text)?;
            self.record_event(&value);
            if value.get("method").and_then(Value::as_str) == Some(event_name) {
                return Ok(());
            }
        }
    }

    fn record_event(&mut self, value: &Value) {
        match value.get("method").and_then(Value::as_str) {
            Some("Runtime.consoleAPICalled") => {
                let level = value
                    .pointer("/params/type")
                    .and_then(Value::as_str)
                    .unwrap_or("log")
                    .to_string();
                let message = value
                    .pointer("/params/args")
                    .and_then(Value::as_array)
                    .map(|args| {
                        args.iter()
                            .filter_map(|arg| {
                                arg.get("value")
                                    .or_else(|| arg.get("description"))
                                    .and_then(Value::as_str)
                            })
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
                    .unwrap_or_default();
                if !message.is_empty() {
                    self.recent_console_entries
                        .push(BrowserConsoleEntry { level, message });
                    trim_vec(&mut self.recent_console_entries, 30);
                }
            }
            Some("Network.requestWillBeSent") => {
                let request = value.pointer("/params/request");
                let method = request
                    .and_then(|request| request.get("method"))
                    .and_then(Value::as_str)
                    .unwrap_or("GET")
                    .to_string();
                let url = request
                    .and_then(|request| request.get("url"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if should_record_network_url(&url) {
                    self.recent_network_entries.push(BrowserNetworkEntry {
                        method,
                        url,
                        status: None,
                    });
                    trim_vec(&mut self.recent_network_entries, 40);
                }
            }
            Some("Network.responseReceived") => {
                let response = value.pointer("/params/response");
                let url = response
                    .and_then(|response| response.get("url"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let status = response
                    .and_then(|response| response.get("status"))
                    .and_then(Value::as_i64);
                if should_record_network_url(url) {
                    if let Some(entry) = self
                        .recent_network_entries
                        .iter_mut()
                        .rev()
                        .find(|entry| entry.url == url && entry.status.is_none())
                    {
                        entry.status = status;
                    } else {
                        self.recent_network_entries.push(BrowserNetworkEntry {
                            method: "GET".to_string(),
                            url: url.to_string(),
                            status,
                        });
                        trim_vec(&mut self.recent_network_entries, 40);
                    }
                }
            }
            _ => {}
        }
    }
}

fn version_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/json/version")
}

fn trim_vec<T>(items: &mut Vec<T>, max_len: usize) {
    if items.len() > max_len {
        items.drain(0..items.len() - max_len);
    }
}

fn should_record_network_url(url: &str) -> bool {
    !(url.is_empty()
        || url.starts_with("data:")
        || url.starts_with("blob:")
        || url.starts_with("devtools:"))
}

fn browser_context_script() -> &'static str {
    r#"
(() => {
  const MAX_HTML = 120000;
  const MAX_TEXT = 30000;
  const MAX_ELEMENTS = 220;
  const clip = (value, max) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
  const cssEscape = (value) => {
    if (globalThis.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  };
  const selectorFor = (el) => {
    if (!el || !el.tagName) return "";
    if (el.id) return `#${cssEscape(el.id)}`;
    const testId = el.getAttribute("data-testid") || el.getAttribute("data-test");
    if (testId) return `[data-testid="${String(testId).replace(/"/g, '\\"')}"]`;
    const name = el.getAttribute("name");
    if (name) return `${el.tagName.toLowerCase()}[name="${String(name).replace(/"/g, '\\"')}"]`;
    const parts = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
      const tag = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const siblings = Array.from(parent.children).filter((item) => item.tagName === current.tagName);
      const index = siblings.indexOf(current) + 1;
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
      current = parent;
    }
    return parts.join(" > ");
  };
  const elementKind = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || el.getAttribute("role") === "button") return "button";
    if (tag === "select") return "select";
    if (tag === "textarea") return "textarea";
    return "input";
  };
  const labelFor = (el) => {
    const id = el.id;
    const label = id ? document.querySelector(`label[for="${cssEscape(id)}"]`) : null;
    return clip(
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("title") ||
      el.innerText ||
      el.value ||
      label?.innerText ||
      el.getAttribute("name") ||
      el.getAttribute("href") ||
      el.tagName.toLowerCase(),
      180
    );
  };
  const interactiveElements = Array.from(
    document.querySelectorAll("a,button,input,textarea,select,[role='button'],[contenteditable='true']")
  )
    .filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })
    .slice(0, MAX_ELEMENTS)
    .map((el) => ({
      kind: elementKind(el),
      label: labelFor(el),
      selector: selectorFor(el),
    }));
  return {
    htmlExcerpt: String(document.documentElement?.outerHTML || "").slice(0, MAX_HTML),
    visibleText: clip(document.body?.innerText || "", MAX_TEXT),
    interactiveElements,
  };
})()
"#
}
