use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct BrowserSession {
    pub environment_id: String,
    pub pid: u32,
    pub cdp_port: u16,
    pub websocket_url: Option<String>,
    pub started_at: String,
    pub profile_dir: String,
}

#[derive(Clone, Default)]
pub struct SessionRegistry {
    inner: Arc<Mutex<HashMap<String, BrowserSession>>>,
}

impl SessionRegistry {
    pub fn get(&self, environment_id: &str) -> Option<BrowserSession> {
        self.inner.lock().ok()?.get(environment_id).cloned()
    }

    pub fn upsert(&self, session: BrowserSession) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.insert(session.environment_id.clone(), session);
        }
    }

    pub fn remove(&self, environment_id: &str) -> Option<BrowserSession> {
        self.inner.lock().ok()?.remove(environment_id)
    }

    pub fn list(&self) -> Vec<BrowserSession> {
        self.inner
            .lock()
            .map(|inner| inner.values().cloned().collect())
            .unwrap_or_default()
    }
}
