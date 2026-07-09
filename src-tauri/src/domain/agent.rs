use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct AgentBrowserActionInput {
    pub environment_id: String,
    pub action: String,
    pub url: Option<String>,
    pub selector: Option<String>,
    pub text: Option<String>,
    pub expression: Option<String>,
    pub milliseconds: Option<u64>,
    pub include_screenshot: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct AgentRecordingEvent {
    pub kind: String,
    pub method: Option<String>,
    pub url: Option<String>,
    pub status: Option<i64>,
    pub resource_type: Option<String>,
    pub title: Option<String>,
    pub timestamp: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct AgentRecordingSummary {
    pub environment_id: String,
    pub is_recording: bool,
    pub started_at: Option<String>,
    pub stopped_at: Option<String>,
    pub total_events: usize,
    pub total_requests: usize,
    pub total_responses: usize,
    pub events: Vec<AgentRecordingEvent>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SaveAgentHistoryInput {
    pub environment_id: String,
    pub session_id: Option<String>,
    pub messages: Vec<Value>,
    pub api_messages: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct AgentHistorySnapshot {
    pub environment_id: String,
    pub session_id: String,
    pub title: String,
    pub messages: Vec<Value>,
    pub api_messages: Vec<Value>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub path: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct AgentHistorySession {
    pub environment_id: String,
    pub session_id: String,
    pub title: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub message_count: usize,
    pub path: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SaveAgentArtifactInput {
    pub environment_id: String,
    pub session_id: String,
    pub artifact_id: String,
    pub kind: String,
    pub content: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ReadAgentArtifactInput {
    pub environment_id: String,
    pub session_id: String,
    pub artifact_id: String,
    pub max_chars: Option<usize>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct AgentArtifactRef {
    pub environment_id: String,
    pub session_id: String,
    pub artifact_id: String,
    pub kind: String,
    pub path: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct AgentArtifactContent {
    pub artifact_id: String,
    pub kind: String,
    pub content: String,
    pub bytes: u64,
    pub truncated: bool,
}
