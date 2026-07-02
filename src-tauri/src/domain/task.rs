use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct AutomationTask {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub script: String,
    pub timeout_sec: i64,
    pub api_version: String,
    pub permissions: Value,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SaveTaskInput {
    pub id: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub script: String,
    pub timeout_sec: i64,
    pub permissions: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ValidateTaskScriptResult {
    pub valid: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}
