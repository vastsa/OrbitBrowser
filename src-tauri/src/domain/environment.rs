use super::proxy::ProxyConfig;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct Environment {
    pub id: String,
    pub name: String,
    pub group_id: Option<String>,
    pub tags: Vec<String>,
    pub notes: Option<String>,
    pub browser_kind: BrowserKind,
    pub chrome_path_override: Option<String>,
    pub profile_dir: String,
    pub proxy_config: ProxyConfig,
    pub locale: String,
    pub timezone_id: Option<String>,
    pub geolocation_latitude: Option<f64>,
    pub geolocation_longitude: Option<f64>,
    pub user_agent: Option<String>,
    pub platform: Option<String>,
    pub web_rtc_protection: bool,
    pub viewport_width: i64,
    pub viewport_height: i64,
    pub device_scale_factor: f64,
    pub environment_mode: EnvironmentMode,
    pub seed: Option<String>,
    pub headless: bool,
    pub start_url: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BrowserKind {
    Chrome,
    Chromium,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EnvironmentMode {
    Standard,
    Custom,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SaveEnvironmentInput {
    pub id: Option<String>,
    pub name: String,
    pub group_id: Option<String>,
    pub tags: Vec<String>,
    pub notes: Option<String>,
    pub browser_kind: BrowserKind,
    pub chrome_path_override: Option<String>,
    pub proxy_config: ProxyConfig,
    pub locale: String,
    pub timezone_id: Option<String>,
    pub geolocation_latitude: Option<f64>,
    pub geolocation_longitude: Option<f64>,
    pub user_agent: Option<String>,
    pub platform: Option<String>,
    pub web_rtc_protection: bool,
    pub viewport_width: i64,
    pub viewport_height: i64,
    pub device_scale_factor: f64,
    pub environment_mode: EnvironmentMode,
    pub seed: Option<String>,
    pub headless: bool,
    pub start_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct EnvironmentRuntimeStatus {
    pub environment_id: String,
    pub status: RuntimeStatus,
    pub pid: Option<u32>,
    pub cdp_port: Option<u16>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeStatus {
    Stopped,
    Starting,
    Running,
    Stopping,
    Crashed,
    Unknown,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct BrowserSessionRecord {
    pub environment_id: String,
    pub pid: u32,
    pub cdp_port: u16,
    pub websocket_url: Option<String>,
    pub profile_dir: String,
    pub started_at: String,
    pub last_seen_at: String,
}
