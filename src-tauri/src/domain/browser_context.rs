use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct BrowserContextSnapshot {
    pub url: String,
    pub title: String,
    pub screenshot_base64: Option<String>,
    pub html_excerpt: String,
    pub visible_text: String,
    pub interactive_elements: Vec<BrowserInteractiveElement>,
    pub console_entries: Vec<BrowserConsoleEntry>,
    pub network_entries: Vec<BrowserNetworkEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct BrowserInteractiveElement {
    pub kind: String,
    pub label: String,
    pub selector: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct BrowserConsoleEntry {
    pub level: String,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct BrowserNetworkEntry {
    pub method: String,
    pub url: String,
    pub status: Option<i64>,
}
