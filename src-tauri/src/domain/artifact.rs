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
