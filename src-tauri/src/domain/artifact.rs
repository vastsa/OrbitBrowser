use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RunArtifact {
    pub id: String,
    pub run_id: String,
    pub kind: String,
    pub label: String,
    pub path: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RunArtifactContent {
    pub path: String,
    pub label: String,
    pub kind: String,
    pub content: String,
    pub bytes: u64,
    pub truncated: bool,
}
