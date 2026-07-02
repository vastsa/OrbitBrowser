use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct Settings {
    pub chrome_path: Option<String>,
    pub default_concurrency: i64,
    pub default_locale: String,
    pub default_timezone_id: String,
    pub default_viewport_width: i64,
    pub default_viewport_height: i64,
    pub data_dir: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SaveSettingsInput {
    pub chrome_path: Option<String>,
    pub default_concurrency: i64,
    pub default_locale: String,
    pub default_timezone_id: String,
    pub default_viewport_width: i64,
    pub default_viewport_height: i64,
}
