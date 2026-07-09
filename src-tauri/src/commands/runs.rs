use crate::app_state::AppState;
use crate::domain::artifact::{RunArtifact, RunArtifactContent};
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
pub fn read_run_artifact(
    state: State<'_, AppState>,
    path: String,
    max_chars: Option<usize>,
) -> AppResult<RunArtifactContent> {
    let artifact = artifact_repo::get_by_path(state.db(), &path)?;
    let absolute = state.data_dir().join(&artifact.path);
    if !absolute.exists() {
        return Err(AppError::new(
            "artifact_not_found",
            "Run artifact does not exist",
        ));
    }

    let bytes = std::fs::metadata(&absolute)?.len();
    let max_chars = max_chars.unwrap_or(20_000).clamp(1_000, 100_000);
    let mut content = if matches!(artifact.kind.as_str(), "screenshot" | "file") {
        format!(
            "Binary artifact is not inlined. kind={}, label={}, path={}",
            artifact.kind, artifact.label, artifact.path
        )
    } else {
        String::from_utf8_lossy(&std::fs::read(&absolute)?).to_string()
    };
    let truncated = content.chars().count() > max_chars;
    if truncated {
        content = content.chars().take(max_chars).collect::<String>();
        content.push_str("…[truncated]");
    }

    Ok(RunArtifactContent {
        path: artifact.path,
        label: artifact.label,
        kind: artifact.kind,
        content,
        bytes,
        truncated,
    })
}

#[tauri::command]
pub fn delete_run(state: State<'_, AppState>, run_id: String) -> AppResult<()> {
    delete_runs(state, vec![run_id])
}

#[tauri::command]
pub fn delete_runs(state: State<'_, AppState>, run_ids: Vec<String>) -> AppResult<()> {
    if run_ids.is_empty() {
        return Err(AppError::new("validation_error", "Select at least one run"));
    }

    let mut runs = Vec::with_capacity(run_ids.len());
    for run_id in &run_ids {
        let run = run_repo::get_run(state.db(), run_id)?;
        if is_active_run(&run.status) {
            return Err(AppError::new(
                "run_active",
                "Active runs cannot be deleted directly. Cancel them first.",
            ));
        }
        runs.push(run);
    }

    for run in runs {
        let artifact_dir = run_repo::delete_run(state.db(), &run.id)?;
        if let Some(relative_dir) = artifact_dir {
            let path = state.data_dir().join(relative_dir);
            if path.exists() {
                let _ = std::fs::remove_dir_all(path);
            }
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
