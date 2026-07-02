use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPermissions {
    pub screenshots: bool,
    pub external_urls: Vec<String>,
    pub clipboard: bool,
}

impl Default for TaskPermissions {
    fn default() -> Self {
        Self {
            screenshots: true,
            external_urls: vec!["<all_urls>".to_string()],
            clipboard: true,
        }
    }
}
