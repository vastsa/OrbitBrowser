use crate::app_state::AppState;
use crate::domain::artifact::RunArtifact;
use crate::domain::run::{RunLog, TaskRun, TaskRunStatus};
use crate::errors::{AppError, AppResult};
use crate::storage::{artifact_repo, log_repo, run_repo};
use tauri::State;

#[tauri::command]
pub fn list_runs(state: State<'_, AppState>) -> AppResult<Vec<TaskRun>> {
    run_repo::list_runs(state.db())
}

#[tauri::command]
pub fn get_run_logs(state: State<'_, AppState>, run_id: String) -> AppResult<Vec<RunLog>> {
    log_repo::list(state.db(), &run_id)
}

#[tauri::command]
pub fn list_run_artifacts(
    state: State<'_, AppState>,
    run_id: String,
) -> AppResult<Vec<RunArtifact>> {
    artifact_repo::list(state.db(), &run_id)
}

#[tauri::command]
pub fn delete_run(state: State<'_, AppState>, run_id: String) -> AppResult<()> {
    let run = run_repo::get_run(state.db(), &run_id)?;
    if is_active_run(&run.status) {
        return Err(AppError::new(
            "run_active",
            "Active runs cannot be deleted directly. Cancel them first.",
        ));
    }

    let artifact_dir = run_repo::delete_run(state.db(), &run_id)?;
    if let Some(relative_dir) = artifact_dir {
        let path = state.data_dir().join(relative_dir);
        if path.exists() {
            let _ = std::fs::remove_dir_all(path);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn open_run_artifact(state: State<'_, AppState>, path: String) -> AppResult<()> {
    let absolute = state.data_dir().join(path);
    if !absolute.exists() {
        return Err(AppError::new(
            "artifact_not_found",
            "Run artifact does not exist",
        ));
    }
    super::open_path(&absolute)
}

#[tauri::command]
pub fn open_run_artifacts_dir(state: State<'_, AppState>, run_id: String) -> AppResult<()> {
    let run = run_repo::get_run(state.db(), &run_id)?;
    let path = state.data_dir().join(
        run.artifacts_dir
            .unwrap_or_else(|| format!("runs/{run_id}")),
    );
    std::fs::create_dir_all(&path)?;
    super::open_path(&path)
}

fn is_active_run(status: &TaskRunStatus) -> bool {
    matches!(
        status,
        TaskRunStatus::Queued
            | TaskRunStatus::Starting
            | TaskRunStatus::Running
            | TaskRunStatus::CancelRequested
    )
}
