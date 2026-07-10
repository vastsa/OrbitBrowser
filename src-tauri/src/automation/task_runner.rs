use crate::app_state::AppState;
use crate::automation::cancellation::CancellationToken;
use crate::automation::deno_runtime::{self, ScriptRuntimeInput};
use crate::automation::permissions::TaskPermissions;
use crate::browser::process_manager;
use crate::commands::environments::{start_environment_inner, stop_environment_inner};
use crate::domain::run::{RunLog, RunOptions, TaskRun, TaskRunStatus};
use crate::domain::task::AutomationTask;
use crate::errors::{AppError, AppResult};
use crate::storage::{environment_repo, log_repo, run_repo};
use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub async fn execute_task_run(
    state: AppState,
    app: Option<AppHandle>,
    run: TaskRun,
    task: AutomationTask,
    options: RunOptions,
    cancellation: CancellationToken,
) -> AppResult<()> {
    if cancellation.is_cancelled() {
        mark_finished_with_events(
            &state,
            app.as_ref(),
            &run,
            TaskRunStatus::Cancelled,
            Some("task_cancelled"),
            Some("Task was cancelled"),
        )?;
        return Err(AppError::new("task_cancelled", "Task was cancelled"));
    }

    let timeout_sec = run.timeout_sec.max(1) as u64;
    let execution = tokio::time::timeout(
        Duration::from_secs(timeout_sec),
        execute_task_run_inner(
            state.clone(),
            app.clone(),
            run.clone(),
            task,
            options,
            cancellation.clone(),
        ),
    )
    .await;

    match execution {
        Ok(Ok(())) => Ok(()),
        Ok(Err(err)) => {
            let status = match err.code.as_str() {
                "task_cancelled" => TaskRunStatus::Cancelled,
                "task_timeout" => TaskRunStatus::TimedOut,
                _ => TaskRunStatus::Failed,
            };
            mark_finished_with_events(
                &state,
                app.as_ref(),
                &run,
                status,
                Some(&err.code),
                Some(&err.message),
            )?;
            append_log_with_event(
                &state,
                app.as_ref(),
                &run,
                "error",
                &err.message,
                Some(err.details.clone()),
            )?;
            Err(err)
        }
        Err(_) => {
            cancellation.cancel();
            mark_finished_with_events(
                &state,
                app.as_ref(),
                &run,
                TaskRunStatus::TimedOut,
                Some("task_timeout"),
                Some("Task execution timed out"),
            )?;
            append_log_with_event(
                &state,
                app.as_ref(),
                &run,
                "error",
                "Task execution timed out",
                None,
            )?;
            Err(AppError::new("task_timeout", "Task execution timed out").retryable(true))
        }
    }
}

async fn execute_task_run_inner(
    state: AppState,
    app: Option<AppHandle>,
    run: TaskRun,
    task: AutomationTask,
    options: RunOptions,
    cancellation: CancellationToken,
) -> AppResult<()> {
    let env = environment_repo::get(state.db(), &run.environment_id)?;
    let artifacts_dir = state.data_dir().join(
        run.artifacts_dir
            .clone()
            .unwrap_or_else(|| format!("runs/{}", run.id)),
    );
    std::fs::create_dir_all(artifacts_dir.join("screenshots"))?;
    std::fs::create_dir_all(artifacts_dir.join("artifacts"))?;

    ensure_not_cancelled(&cancellation)?;
    mark_started_with_events(&state, app.as_ref(), &run)?;
    append_log_with_event(
        &state,
        app.as_ref(),
        &run,
        "info",
        &format!("Starting task: {}", task.name),
        None,
    )?;

    let cdp_port =
        resolve_cdp_port(&state, &run.environment_id, options.auto_start_browser).await?;
    let permissions =
        serde_json::from_value::<TaskPermissions>(task.permissions.clone()).unwrap_or_default();
    let snapshot = deno_runtime::execute_script(ScriptRuntimeInput {
        state: state.clone(),
        app: app.clone(),
        run: run.clone(),
        script: task.script.clone(),
        environment: env,
        permissions,
        cdp_port,
        artifacts_dir,
        cancellation: cancellation.clone(),
        timeout: Duration::from_secs(run.timeout_sec.max(1) as u64),
    })
    .await?;
    append_log_with_event(
        &state,
        app.as_ref(),
        &run,
        "info",
        &format!("Task completed: {} / {}", snapshot.title, snapshot.url),
        Some(json!({ "title": snapshot.title, "url": snapshot.url })),
    )?;
    mark_finished_with_events(
        &state,
        app.as_ref(),
        &run,
        TaskRunStatus::Succeeded,
        None,
        None,
    )?;

    if options.close_browser_after_run {
        stop_environment_inner(&state, &run.environment_id)?;
    }

    Ok(())
}

async fn resolve_cdp_port(
    state: &AppState,
    environment_id: &str,
    auto_start_browser: bool,
) -> AppResult<u16> {
    if let Some(session) = state.sessions().get(environment_id) {
        if process_manager::pid_alive(session.pid) {
            return Ok(session.cdp_port);
        }
    }

    for record in environment_repo::list_session_records(state.db())? {
        if record.environment_id == environment_id && process_manager::pid_alive(record.pid) {
            return Ok(record.cdp_port);
        }
    }

    if !auto_start_browser {
        return Err(AppError::new(
            "chrome_not_running",
            "Environment is not running. Start the browser first or enable auto-start.",
        ));
    }

    let status = start_environment_inner(state, environment_id.to_string()).await?;
    status.cdp_port.ok_or_else(|| {
        AppError::new(
            "browser_control_unavailable",
            "Browser started but no control port is available",
        )
    })
}

fn ensure_not_cancelled(cancellation: &CancellationToken) -> AppResult<()> {
    if cancellation.is_cancelled() {
        Err(AppError::new("task_cancelled", "Task was cancelled"))
    } else {
        Ok(())
    }
}

fn mark_started_with_events(
    state: &AppState,
    app: Option<&AppHandle>,
    run: &TaskRun,
) -> AppResult<()> {
    run_repo::mark_started(state.db(), &run.id)?;
    emit_run_status(app, &run.id, TaskRunStatus::Running);
    emit_batch_progress(state, app, run)?;
    Ok(())
}

fn mark_finished_with_events(
    state: &AppState,
    app: Option<&AppHandle>,
    run: &TaskRun,
    status: TaskRunStatus,
    error_code: Option<&str>,
    error_message: Option<&str>,
) -> AppResult<()> {
    run_repo::mark_finished(
        state.db(),
        &run.id,
        status.clone(),
        error_code,
        error_message,
    )?;
    emit_run_status(app, &run.id, status);
    emit_batch_progress(state, app, run)?;
    Ok(())
}

fn append_log_with_event(
    state: &AppState,
    app: Option<&AppHandle>,
    run: &TaskRun,
    level: &str,
    message: &str,
    data: Option<Value>,
) -> AppResult<RunLog> {
    let log = log_repo::append(state.db(), &run.id, level, message, data)?;
    if let Some(app) = app {
        let _ = app.emit("run_log_appended", &log);
    }
    Ok(log)
}

fn emit_run_status(app: Option<&AppHandle>, run_id: &str, status: TaskRunStatus) {
    if let Some(app) = app {
        let _ = app.emit(
            "run_status_changed",
            RunStatusEvent {
                run_id: run_id.to_string(),
                status,
                updated_at: Utc::now().to_rfc3339(),
            },
        );
    }
}

fn emit_batch_progress(state: &AppState, app: Option<&AppHandle>, run: &TaskRun) -> AppResult<()> {
    let Some(app) = app else {
        return Ok(());
    };
    let Some(batch_id) = run.batch_id.as_deref() else {
        return Ok(());
    };
    let batch = run_repo::get_batch(state.db(), batch_id)?;
    let _ = app.emit("batch_progress_changed", &batch);
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
struct RunStatusEvent {
    run_id: String,
    status: TaskRunStatus,
    updated_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::environment::{BrowserKind, EnvironmentMode, SaveEnvironmentInput};
    use crate::domain::proxy::ProxyConfig;
    use crate::domain::run::RunTaskInput;
    use crate::domain::task::SaveTaskInput;
    use crate::storage::{artifact_repo, environment_repo, task_repo};
    use serde_json::json;

    #[tokio::test]
    #[ignore = "launches the local Chrome/Chromium browser"]
    async fn browser_runtime_smoke_executes_js_task() -> AppResult<()> {
        let data_dir =
            std::env::temp_dir().join(format!("orbit-browser-smoke-{}", uuid::Uuid::new_v4()));
        let state = AppState::initialize(data_dir.clone())?;
        let env = environment_repo::save(
            state.db(),
            SaveEnvironmentInput {
                id: Some("env_browser_smoke".to_string()),
                name: "Browser Smoke".to_string(),
                group_id: None,
                tags: Vec::new(),
                notes: None,
                browser_kind: BrowserKind::Chrome,
                chrome_path_override: None,
                proxy_config: ProxyConfig::default(),
                locale: "en-US".to_string(),
                timezone_id: Some("UTC".to_string()),
                geolocation_latitude: Some(35.6895),
                geolocation_longitude: Some(139.6917),
                user_agent: None,
                platform: None,
                web_rtc_protection: true,
                viewport_width: 900,
                viewport_height: 700,
                device_scale_factor: 1.0,
                environment_mode: EnvironmentMode::Standard,
                seed: None,
                headless: true,
                start_url: Some("about:blank".to_string()),
            },
        )?;
        let task = task_repo::save(
            state.db(),
            SaveTaskInput {
                id: Some("task_browser_smoke".to_string()),
                name: "Browser Smoke".to_string(),
                description: None,
                script: r##"
await page.goto("https://example.com", { timeout: 10000 });
await page.wait("h1", { timeout: 5000 });
const title = await page.title();
const url = await page.url();
const timezone = await page.evaluate("Intl.DateTimeFormat().resolvedOptions().timeZone");
if (timezone !== "UTC") {
  throw new Error(`timezone override failed: ${timezone}`);
}
await sleep(1500);
const positionResult = await page.evaluate(`
new Promise((resolve) => {
  navigator.geolocation.getCurrentPosition(
    (position) => resolve({ ok: true,
      latitude: position.coords.latitude,
      longitude: position.coords.longitude
    }),
    (error) => resolve({ ok: false, code: error.code, message: error.message }),
    { timeout: 5000 }
  );
})
`);
if (!positionResult.ok) {
  throw new Error(`geolocation read failed: ${JSON.stringify(positionResult)}`);
}
const position = positionResult;
if (Math.abs(position.latitude - 35.6895) > 0.0001 || Math.abs(position.longitude - 139.6917) > 0.0001) {
  throw new Error(`geolocation override failed: ${position.latitude},${position.longitude}`);
}
log.info(`title:${title}`);
await run.outputJson("result", { title, url, timezone, position });
"##
                .trim()
                .to_string(),
                timeout_sec: 30,
                permissions: json!({}),
            },
        )?;
        let batch = run_repo::create_queued_batch(
            state.db(),
            RunTaskInput {
                task_id: task.id.clone(),
                environment_ids: vec![env.id.clone()],
                options: Some(RunOptions {
                    auto_start_browser: true,
                    close_browser_after_run: true,
                    max_concurrency: 1,
                    stop_on_first_error: true,
                }),
            },
            task.timeout_sec,
        )?;
        let run = run_repo::list_runs_by_batch(state.db(), &batch.id)?
            .into_iter()
            .next()
            .expect("queued run should exist");

        let result = execute_task_run(
            state.clone(),
            None,
            run.clone(),
            task,
            batch.options,
            CancellationToken::default(),
        )
        .await;
        let _ = stop_environment_inner(&state, &env.id);

        if let Err(err) = result {
            let _ = std::fs::remove_dir_all(&data_dir);
            return Err(err);
        }
        let finished = run_repo::get_run(state.db(), &run.id)?;
        assert_eq!(finished.status, TaskRunStatus::Succeeded);
        let artifacts = artifact_repo::list(state.db(), &run.id)?;
        assert!(artifacts.iter().any(|artifact| artifact.label == "result"));

        let _ = std::fs::remove_dir_all(&data_dir);
        Ok(())
    }
}
