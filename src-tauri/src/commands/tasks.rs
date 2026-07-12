use crate::app_state::AppState;
use crate::automation::{deno_runtime, task_runner};
use crate::domain::run::{RunBatch, RunTaskInput, TaskRunStatus};
use crate::domain::task::{AutomationTask, SaveTaskInput, ValidateTaskScriptResult};
use crate::errors::{AppError, AppResult};
use crate::storage::{legacy_cleanup, run_repo, task_repo};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Semaphore;

#[tauri::command]
pub fn list_tasks(state: State<'_, AppState>) -> AppResult<Vec<AutomationTask>> {
    task_repo::list(state.db())
}

#[tauri::command]
pub fn save_task(state: State<'_, AppState>, input: SaveTaskInput) -> AppResult<AutomationTask> {
    let validation = validate_script(&input.script);
    if !validation.valid {
        return Err(AppError::new(
            "script_compile_error",
            validation
                .errors
                .first()
                .cloned()
                .unwrap_or_else(|| "Script validation failed".to_string()),
        ));
    }
    task_repo::save(state.db(), input)
}

#[tauri::command]
pub fn delete_task(state: State<'_, AppState>, id: String) -> AppResult<()> {
    task_repo::get(state.db(), &id)?;
    let artifact_dirs = run_repo::delete_runs_for_task(state.db(), &id)?;
    legacy_cleanup::delete_ai_conversations_for_task(state.db(), &id)?;
    legacy_cleanup::clear_agent_task_reference(state.db(), &id)?;
    task_repo::hard_delete(state.db(), &id)?;
    cleanup_artifact_dirs(&state, artifact_dirs);
    Ok(())
}

#[tauri::command]
pub fn validate_task_script(script: String) -> ValidateTaskScriptResult {
    validate_script(&script)
}

#[tauri::command]
pub async fn run_task(
    app: AppHandle,
    state: State<'_, AppState>,
    input: RunTaskInput,
) -> AppResult<RunBatch> {
    let task = task_repo::get(state.db(), &input.task_id)?;
    let options = input.options.clone().unwrap_or_default();
    let batch = run_repo::create_queued_batch(state.db(), input, task.timeout_sec)?;
    let _ = app.emit("batch_progress_changed", &batch);
    spawn_batch_runs(app, state.inner().clone(), batch.clone(), task, options);
    Ok(batch)
}

#[tauri::command]
pub fn cancel_run(app: AppHandle, state: State<'_, AppState>, run_id: String) -> AppResult<()> {
    let run = run_repo::get_run(state.db(), &run_id)?;
    let status = if state.cancel_run(&run_id) {
        TaskRunStatus::CancelRequested
    } else {
        TaskRunStatus::Cancelled
    };
    run_repo::set_status(state.db(), &run_id, status.clone())?;
    emit_run_status(&app, &run_id, status);
    emit_batch_progress(&app, &state, &run)?;
    Ok(())
}

#[tauri::command]
pub fn cancel_batch(app: AppHandle, state: State<'_, AppState>, batch_id: String) -> AppResult<()> {
    for run in run_repo::list_runs_by_batch(state.db(), &batch_id)? {
        if matches!(
            run.status,
            TaskRunStatus::Succeeded
                | TaskRunStatus::Failed
                | TaskRunStatus::Cancelled
                | TaskRunStatus::TimedOut
                | TaskRunStatus::Interrupted
        ) {
            continue;
        }
        let status = if state.cancel_run(&run.id) {
            TaskRunStatus::CancelRequested
        } else {
            TaskRunStatus::Cancelled
        };
        run_repo::set_status(state.db(), &run.id, status.clone())?;
        emit_run_status(&app, &run.id, status);
    }
    if let Ok(batch) = run_repo::get_batch(state.db(), &batch_id) {
        let _ = app.emit("batch_progress_changed", &batch);
    }
    Ok(())
}

#[tauri::command]
pub fn retry_run(app: AppHandle, state: State<'_, AppState>, run_id: String) -> AppResult<()> {
    let retry = run_repo::create_retry_run(state.db(), &run_id)?;
    let task = task_repo::get(state.db(), &retry.task_id)?;
    let batch = retry
        .batch_id
        .as_deref()
        .and_then(|id| run_repo::get_batch(state.db(), id).ok());
    let options = batch
        .as_ref()
        .map(|batch| batch.options.clone())
        .unwrap_or_default();
    if let Some(batch) = batch {
        let _ = app.emit("batch_progress_changed", &batch);
    }
    tauri::async_runtime::spawn(execute_one_run(
        app,
        state.inner().clone(),
        retry,
        task,
        options,
    ));
    Ok(())
}

pub fn resume_queued_batches(app: AppHandle, state: AppState) -> AppResult<usize> {
    let batches = run_repo::list_batches_with_queued_runs(state.db())?;
    let total = batches.len();
    for batch in batches {
        let task = match task_repo::get(state.db(), &batch.task_id) {
            Ok(task) => task,
            Err(err) => {
                let _ = app.emit(
                    "diagnostic_warning",
                    format!("Failed to recover batch {}: {}", batch.id, err.message),
                );
                continue;
            }
        };
        let options = batch.options.clone();
        spawn_batch_runs(app.clone(), state.clone(), batch, task, options);
    }
    Ok(total)
}

fn spawn_batch_runs(
    app: AppHandle,
    state: AppState,
    batch: RunBatch,
    task: AutomationTask,
    options: crate::domain::run::RunOptions,
) {
    tauri::async_runtime::spawn(async move {
        let runs = match run_repo::list_runs_by_batch(state.db(), &batch.id) {
            Ok(runs) => runs,
            Err(err) => {
                let _ = app.emit(
                    "diagnostic_warning",
                    format!("Failed to read batch runs: {}", err.message),
                );
                return;
            }
        };

        if options.stop_on_first_error {
            let mut failed = runs.iter().any(|run| {
                matches!(
                    run.status,
                    TaskRunStatus::Failed | TaskRunStatus::TimedOut | TaskRunStatus::Interrupted
                )
            });
            for run in runs {
                if run.status != TaskRunStatus::Queued {
                    continue;
                }
                if failed {
                    let _ = run_repo::set_status(state.db(), &run.id, TaskRunStatus::Cancelled);
                    emit_run_status(&app, &run.id, TaskRunStatus::Cancelled);
                    let _ = emit_batch_progress(&app, &state, &run);
                    continue;
                }
                let result = execute_one_run(
                    app.clone(),
                    state.clone(),
                    run,
                    task.clone(),
                    options.clone(),
                )
                .await;
                failed = result.is_err();
            }
            return;
        }

        let semaphore = Arc::new(Semaphore::new(options.max_concurrency.max(1) as usize));
        let mut handles = Vec::new();
        for run in runs {
            let Ok(permit) = semaphore.clone().acquire_owned().await else {
                continue;
            };
            let app = app.clone();
            let state = state.clone();
            let task = task.clone();
            let options = options.clone();
            handles.push(tauri::async_runtime::spawn(async move {
                let _permit = permit;
                let _ = execute_one_run(app, state, run, task, options).await;
            }));
        }
        for handle in handles {
            let _ = handle.await;
        }
    });
}

async fn execute_one_run(
    app: AppHandle,
    state: AppState,
    run: crate::domain::run::TaskRun,
    task: AutomationTask,
    options: crate::domain::run::RunOptions,
) -> AppResult<()> {
    let current = run_repo::get_run(state.db(), &run.id)?;
    if current.status != TaskRunStatus::Queued {
        return Ok(());
    }
    let token = state.register_cancellation(&run.id);
    let result = task_runner::execute_task_run(
        state.clone(),
        Some(app),
        current.clone(),
        task,
        options,
        token,
    )
    .await;
    state.remove_cancellation(&run.id);
    result
}

fn emit_run_status(app: &AppHandle, run_id: &str, status: TaskRunStatus) {
    let _ = app.emit(
        "run_status_changed",
        serde_json::json!({
            "run_id": run_id,
            "status": status,
            "updated_at": chrono::Utc::now().to_rfc3339(),
        }),
    );
}

fn emit_batch_progress(
    app: &AppHandle,
    state: &AppState,
    run: &crate::domain::run::TaskRun,
) -> AppResult<()> {
    let Some(batch_id) = run.batch_id.as_deref() else {
        return Ok(());
    };
    let batch = run_repo::get_batch(state.db(), batch_id)?;
    let _ = app.emit("batch_progress_changed", &batch);
    Ok(())
}

fn cleanup_artifact_dirs(state: &AppState, artifact_dirs: Vec<String>) {
    for relative_dir in artifact_dirs {
        let path = state.data_dir().join(relative_dir);
        if path.exists() {
            let _ = std::fs::remove_dir_all(path);
        }
    }
}

fn validate_script(script: &str) -> ValidateTaskScriptResult {
    let trimmed = script.trim();
    if trimmed.is_empty() {
        return ValidateTaskScriptResult {
            valid: false,
            errors: vec!["Script cannot be empty".to_string()],
            warnings: Vec::new(),
        };
    }

    if let Err(err) = deno_runtime::validate_script_surface(trimmed) {
        return ValidateTaskScriptResult {
            valid: false,
            errors: vec![err.message],
            warnings: deno_runtime::collect_script_warnings(trimmed),
        };
    }

    ValidateTaskScriptResult {
        valid: true,
        errors: Vec::new(),
        warnings: deno_runtime::collect_script_warnings(trimmed),
    }
}
