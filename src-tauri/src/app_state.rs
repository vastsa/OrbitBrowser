use crate::automation::cancellation::{CancellationRegistry, CancellationToken};
use crate::browser::session_registry::SessionRegistry;
use crate::errors::AppResult;
use crate::storage::db::Db;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    db: Db,
    data_dir: Arc<PathBuf>,
    sessions: SessionRegistry,
    cancellations: CancellationRegistry,
}

impl AppState {
    pub fn initialize(data_dir: PathBuf) -> AppResult<Self> {
        let db = Db::initialize(data_dir.clone())?;
        crate::browser::recovery::recover_startup_state(&db)?;

        Ok(Self {
            db,
            data_dir: Arc::new(data_dir),
            sessions: SessionRegistry::default(),
            cancellations: CancellationRegistry::default(),
        })
    }

    pub fn db(&self) -> &Db {
        &self.db
    }

    pub fn data_dir(&self) -> &PathBuf {
        &self.data_dir
    }

    pub fn sessions(&self) -> &SessionRegistry {
        &self.sessions
    }

    pub fn register_cancellation(&self, run_id: &str) -> CancellationToken {
        self.cancellations.register(run_id)
    }

    pub fn cancel_run(&self, run_id: &str) -> bool {
        self.cancellations.cancel(run_id)
    }

    pub fn remove_cancellation(&self, run_id: &str) {
        self.cancellations.remove(run_id);
    }
}
