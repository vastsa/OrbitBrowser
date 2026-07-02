use crate::browser::{process_manager, profile_manager};
use crate::errors::AppResult;
use crate::storage::db::Db;
use crate::storage::{environment_repo, run_repo};

pub fn recover_startup_state(db: &Db) -> AppResult<()> {
    let interrupted = run_repo::mark_interrupted_on_startup(db)?;
    if interrupted > 0 {
        tracing::info!(interrupted, "marked unfinished task runs as interrupted");
    }

    for record in environment_repo::list_session_records(db)? {
        if !process_manager::pid_alive(record.pid) {
            environment_repo::delete_session_record(db, &record.environment_id)?;
            profile_manager::remove_lock(db.data_dir(), &record.environment_id)?;
        }
    }

    Ok(())
}
