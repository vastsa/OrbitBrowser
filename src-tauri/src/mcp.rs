use crate::app_state::AppState;
use crate::automation::{deno_runtime, task_runner};
use crate::browser::cdp_client::CdpPage;
use crate::browser::chrome_locator;
use crate::commands::diagnostics::{
    cleanup_stale_sessions_inner, cleanup_temp_files_inner, get_diagnostics_inner,
};
use crate::commands::environments::{
    delete_environment_inner, start_environment_inner, stop_environment_inner,
};
use crate::domain::environment::SaveEnvironmentInput;
use crate::domain::run::{RunTaskInput, TaskRun, TaskRunStatus};
use crate::domain::settings::SaveSettingsInput;
use crate::domain::task::{SaveTaskInput, ValidateTaskScriptResult};
use crate::errors::{AppError, AppResult};
use crate::storage::{
    artifact_repo, db::Db, environment_repo, legacy_cleanup, log_repo, run_repo, settings_repo,
    task_repo,
};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::sync::Arc;
use tokio::sync::Semaphore;

#[derive(Debug, Deserialize)]
struct RpcRequest {
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    id: Option<Value>,
    method: String,
    params: Option<Value>,
}

pub fn run_stdio_server(state: AppState) -> AppResult<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|err| AppError::new("mcp_runtime_error", err.to_string()))?;
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = line.map_err(|err| AppError::new("mcp_io_error", err.to_string()))?;
        if line.trim().is_empty() {
            continue;
        }
        let request = match serde_json::from_str::<RpcRequest>(&line) {
            Ok(request) => request,
            Err(err) => {
                write_response(
                    &mut stdout,
                    json!({
                        "jsonrpc": "2.0",
                        "id": Value::Null,
                        "error": { "code": -32700, "message": err.to_string() }
                    }),
                )?;
                continue;
            }
        };

        if request.id.is_none() {
            continue;
        }

        let id = request.id.clone().unwrap_or(Value::Null);
        let response = runtime.block_on(handle_request(state.clone(), request));
        let payload = match response {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(err) => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {
                    "code": -32000,
                    "message": err.message,
                    "data": {
                        "code": err.code,
                        "details": err.details
                    }
                }
            }),
        };
        write_response(&mut stdout, payload)?;
    }

    Ok(())
}

async fn handle_request(state: AppState, request: RpcRequest) -> AppResult<Value> {
    match request.method.as_str() {
        "initialize" => Ok(json!({
            "protocolVersion": "2024-11-05",
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "orbit-browser", "version": env!("CARGO_PKG_VERSION") }
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools() })),
        "tools/call" => {
            let params = request.params.unwrap_or_else(|| json!({}));
            let name = required_str(&params, "name")?;
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            match call_tool(state, name, arguments).await {
                Ok(value) => Ok(tool_result(value, false)?),
                Err(err) => Ok(tool_result(
                    json!({
                        "code": err.code,
                        "message": err.message,
                        "details": err.details,
                        "retryable": err.retryable
                    }),
                    true,
                )?),
            }
        }
        _ => Err(AppError::new(
            "mcp_method_not_found",
            format!("Unsupported MCP method: {}", request.method),
        )),
    }
}

async fn call_tool(state: AppState, name: &str, arguments: Value) -> AppResult<Value> {
    match name {
        "orbit_get_settings" => Ok(json!(settings_repo::get(state.db())?)),
        "orbit_save_settings" => {
            let input: SaveSettingsInput = serde_json::from_value(arguments)?;
            Ok(json!(settings_repo::save(state.db(), input)?))
        }
        "orbit_detect_chrome" => Ok(json!(chrome_locator::detect())),
        "orbit_get_diagnostics" => Ok(json!(get_diagnostics_inner(&state)?)),
        "orbit_cleanup_stale_sessions" => Ok(json!(cleanup_stale_sessions_inner(&state)?)),
        "orbit_cleanup_temp_files" => Ok(json!(cleanup_temp_files_inner(&state)?)),
        "orbit_list_environments" => Ok(json!(environment_repo::list(state.db())?)),
        "orbit_get_environment" => {
            let environment_id = required_str(&arguments, "environment_id")?;
            Ok(json!(environment_repo::get(state.db(), environment_id)?))
        }
        "orbit_save_environment" => {
            let input: SaveEnvironmentInput = serde_json::from_value(arguments)?;
            Ok(json!(environment_repo::save(state.db(), input)?))
        }
        "orbit_duplicate_environment" => {
            let environment_id = required_str(&arguments, "environment_id")?;
            Ok(json!(environment_repo::duplicate(
                state.db(),
                environment_id
            )?))
        }
        "orbit_delete_environment" => {
            let environment_id = required_str(&arguments, "environment_id")?;
            delete_environment_inner(&state, environment_id)?;
            Ok(json!({ "environment_id": environment_id, "deleted": true }))
        }
        "orbit_start_environment" => {
            let environment_id = required_str(&arguments, "environment_id")?;
            Ok(json!(
                start_environment_inner(&state, environment_id.to_string()).await?
            ))
        }
        "orbit_stop_environment" => {
            let environment_id = required_str(&arguments, "environment_id")?;
            stop_environment_inner(&state, environment_id)?;
            Ok(json!({ "environment_id": environment_id, "status": "stopped" }))
        }
        "orbit_list_tasks" => Ok(json!(task_repo::list(state.db())?)),
        "orbit_get_task" => {
            let task_id = required_str(&arguments, "task_id")?;
            Ok(json!(task_repo::get(state.db(), task_id)?))
        }
        "orbit_save_task" => {
            let input: SaveTaskInput = serde_json::from_value(arguments)?;
            validate_script(&input.script)?;
            Ok(json!(task_repo::save(state.db(), input)?))
        }
        "orbit_validate_task_script" => {
            let script = required_str(&arguments, "script")?;
            Ok(json!(validate_task_script(script)))
        }
        "orbit_delete_task" => {
            let task_id = required_str(&arguments, "task_id")?;
            delete_task(&state, task_id)?;
            Ok(json!({ "task_id": task_id, "deleted": true }))
        }
        "orbit_run_task" => run_task(state, arguments).await,
        "orbit_cancel_run" => {
            let run_id = required_str(&arguments, "run_id")?;
            cancel_run(&state, run_id)?;
            Ok(json!(run_repo::get_run(state.db(), run_id)?))
        }
        "orbit_cancel_batch" => {
            let batch_id = required_str(&arguments, "batch_id")?;
            let cancelled = cancel_batch(&state, batch_id)?;
            Ok(json!({ "batch_id": batch_id, "cancelled_runs": cancelled }))
        }
        "orbit_retry_run" => {
            let run_id = required_str(&arguments, "run_id")?;
            let retry = retry_run(state, run_id).await?;
            Ok(json!(retry))
        }
        "orbit_list_runs" => Ok(json!(list_runs(state.db(), &arguments)?)),
        "orbit_get_run" => {
            let run_id = required_str(&arguments, "run_id")?;
            Ok(json!(run_repo::get_run(state.db(), run_id)?))
        }
        "orbit_get_run_logs" => {
            let run_id = required_str(&arguments, "run_id")?;
            Ok(json!(log_repo::list(state.db(), run_id)?))
        }
        "orbit_list_run_artifacts" => {
            let run_id = required_str(&arguments, "run_id")?;
            Ok(json!(artifact_repo::list(state.db(), run_id)?))
        }
        "orbit_delete_run" => {
            let run_id = required_str(&arguments, "run_id")?;
            delete_run(&state, run_id)?;
            Ok(json!({ "run_id": run_id, "deleted": true }))
        }
        "orbit_browser_goto" => {
            let mut page = page_for_environment(&state, &arguments).await?;
            let url = required_str(&arguments, "url")?;
            page.goto(
                url,
                std::time::Duration::from_millis(timeout_ms(&arguments, 30_000)),
            )
            .await?;
            Ok(json!(page.snapshot().await?))
        }
        "orbit_browser_click" => {
            let mut page = page_for_environment(&state, &arguments).await?;
            page.click(required_str(&arguments, "selector")?).await?;
            Ok(json!(page.snapshot().await?))
        }
        "orbit_browser_mouse_click" => {
            let mut page = page_for_environment(&state, &arguments).await?;
            page.mouse_click(
                required_number(&arguments, "x")?,
                required_number(&arguments, "y")?,
                arguments
                    .get("button")
                    .and_then(Value::as_str)
                    .unwrap_or("left"),
            )
            .await?;
            Ok(json!(page.snapshot().await?))
        }
        "orbit_browser_type" => {
            let mut page = page_for_environment(&state, &arguments).await?;
            page.type_text(
                required_str(&arguments, "selector")?,
                required_str(&arguments, "text")?,
            )
            .await?;
            Ok(json!(page.snapshot().await?))
        }
        "orbit_browser_wait" => {
            let mut page = page_for_environment(&state, &arguments).await?;
            if let Some(milliseconds) = arguments.get("milliseconds").and_then(Value::as_u64) {
                tokio::time::sleep(std::time::Duration::from_millis(milliseconds)).await;
            } else {
                page.wait_for_selector(
                    required_str(&arguments, "selector")?,
                    std::time::Duration::from_millis(timeout_ms(&arguments, 10_000)),
                )
                .await?;
            }
            Ok(json!(page.snapshot().await?))
        }
        "orbit_browser_context" => {
            let mut page = page_for_environment(&state, &arguments).await?;
            let include_screenshot = arguments
                .get("include_screenshot")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            Ok(json!(page.context_snapshot(include_screenshot).await?))
        }
        "orbit_browser_evaluate" => {
            let mut page = page_for_environment(&state, &arguments).await?;
            Ok(json!({
                "value": page.evaluate(required_str(&arguments, "expression")?).await?
            }))
        }
        "orbit_browser_screenshot" => {
            let mut page = page_for_environment(&state, &arguments).await?;
            let png = page.screenshot_png().await?;
            Ok(json!({
                "mime_type": "image/png",
                "base64": base64::engine::general_purpose::STANDARD.encode(png)
            }))
        }
        _ => Err(AppError::new(
            "mcp_tool_not_found",
            format!("Unsupported MCP tool: {name}"),
        )),
    }
}

async fn run_task(state: AppState, arguments: Value) -> AppResult<Value> {
    let input: RunTaskInput = serde_json::from_value(arguments)?;
    let task = task_repo::get(state.db(), &input.task_id)?;
    let options = input.options.clone().unwrap_or_default();
    let batch = run_repo::create_queued_batch(state.db(), input, task.timeout_sec)?;
    spawn_mcp_batch_runs(state.clone(), batch.id.clone(), task, options);
    Ok(json!({
        "batch": run_repo::get_batch(state.db(), &batch.id)?,
        "runs": run_repo::list_runs_by_batch(state.db(), &batch.id)?
    }))
}

async fn retry_run(state: AppState, run_id: &str) -> AppResult<TaskRun> {
    let retry = run_repo::create_retry_run(state.db(), run_id)?;
    let task = task_repo::get(state.db(), &retry.task_id)?;
    let batch = retry
        .batch_id
        .as_deref()
        .and_then(|id| run_repo::get_batch(state.db(), id).ok());
    let options = batch
        .as_ref()
        .map(|batch| batch.options.clone())
        .unwrap_or_default();
    spawn_mcp_run(state.clone(), retry.id.clone(), task, options);
    run_repo::get_run(state.db(), &retry.id)
}

fn spawn_mcp_batch_runs(
    state: AppState,
    batch_id: String,
    task: crate::domain::task::AutomationTask,
    options: crate::domain::run::RunOptions,
) {
    tokio::spawn(async move {
        let runs = match run_repo::list_runs_by_batch(state.db(), &batch_id) {
            Ok(runs) => runs,
            Err(err) => {
                tracing::warn!(batch_id, error = %err, "Failed to read MCP batch runs");
                return;
            }
        };

        if options.stop_on_first_error {
            let mut failed = false;
            for run in runs {
                if run.status != TaskRunStatus::Queued {
                    continue;
                }
                if failed {
                    let _ = run_repo::set_status(state.db(), &run.id, TaskRunStatus::Cancelled);
                    continue;
                }
                failed =
                    execute_mcp_run(state.clone(), run.id.clone(), task.clone(), options.clone())
                        .await
                        .is_err();
            }
            return;
        }

        let semaphore = Arc::new(Semaphore::new(options.max_concurrency.max(1) as usize));
        let mut handles = Vec::new();
        for run in runs {
            if run.status != TaskRunStatus::Queued {
                continue;
            }
            let Ok(permit) = semaphore.clone().acquire_owned().await else {
                continue;
            };
            let state = state.clone();
            let task = task.clone();
            let options = options.clone();
            handles.push(tokio::spawn(async move {
                let _permit = permit;
                let _ = execute_mcp_run(state, run.id, task, options).await;
            }));
        }
        for handle in handles {
            let _ = handle.await;
        }
    });
}

fn spawn_mcp_run(
    state: AppState,
    run_id: String,
    task: crate::domain::task::AutomationTask,
    options: crate::domain::run::RunOptions,
) {
    tokio::spawn(async move {
        let _ = execute_mcp_run(state, run_id, task, options).await;
    });
}

async fn execute_mcp_run(
    state: AppState,
    run_id: String,
    task: crate::domain::task::AutomationTask,
    options: crate::domain::run::RunOptions,
) -> AppResult<()> {
    let run = run_repo::get_run(state.db(), &run_id)?;
    if run.status != TaskRunStatus::Queued {
        return Ok(());
    }
    let token = state.register_cancellation(&run_id);
    let result =
        task_runner::execute_task_run(state.clone(), None, run, task, options, token).await;
    state.remove_cancellation(&run_id);
    result
}

fn cancel_run(state: &AppState, run_id: &str) -> AppResult<()> {
    let run = run_repo::get_run(state.db(), run_id)?;
    if is_terminal_status(&run.status) {
        return Ok(());
    }
    let status = if state.cancel_run(run_id) {
        TaskRunStatus::CancelRequested
    } else {
        TaskRunStatus::Cancelled
    };
    run_repo::set_status(state.db(), run_id, status)
}

fn cancel_batch(state: &AppState, batch_id: &str) -> AppResult<usize> {
    let mut cancelled = 0;
    for run in run_repo::list_runs_by_batch(state.db(), batch_id)? {
        if is_terminal_status(&run.status) {
            continue;
        }
        let status = if state.cancel_run(&run.id) {
            TaskRunStatus::CancelRequested
        } else {
            TaskRunStatus::Cancelled
        };
        run_repo::set_status(state.db(), &run.id, status)?;
        cancelled += 1;
    }
    Ok(cancelled)
}

fn delete_task(state: &AppState, task_id: &str) -> AppResult<()> {
    task_repo::get(state.db(), task_id)?;
    let artifact_dirs = run_repo::delete_runs_for_task(state.db(), task_id)?;
    legacy_cleanup::delete_ai_conversations_for_task(state.db(), task_id)?;
    legacy_cleanup::clear_agent_task_reference(state.db(), task_id)?;
    task_repo::hard_delete(state.db(), task_id)?;
    cleanup_artifact_dirs(state, artifact_dirs);
    Ok(())
}

fn delete_run(state: &AppState, run_id: &str) -> AppResult<()> {
    let run = run_repo::get_run(state.db(), run_id)?;
    if !is_terminal_status(&run.status) {
        return Err(AppError::new(
            "run_active",
            "Active runs cannot be deleted directly. Cancel them first.",
        ));
    }
    if let Some(relative_dir) = run_repo::delete_run(state.db(), run_id)? {
        let path = state.data_dir().join(relative_dir);
        if path.exists() {
            let _ = std::fs::remove_dir_all(path);
        }
    }
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

fn list_runs(db: &Db, arguments: &Value) -> AppResult<Vec<TaskRun>> {
    let task_id = optional_str(arguments, "task_id");
    let environment_id = optional_str(arguments, "environment_id");
    let batch_id = optional_str(arguments, "batch_id");
    let status = optional_str(arguments, "status");
    let limit = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(200)
        .clamp(1, 500) as usize;

    let mut runs = if let Some(batch_id) = batch_id {
        run_repo::list_runs_by_batch(db, batch_id)?
    } else {
        run_repo::list_runs(db)?
    };
    runs.retain(|run| {
        task_id.is_none_or(|value| run.task_id == value)
            && environment_id.is_none_or(|value| run.environment_id == value)
            && status.is_none_or(|value| value == "all" || run_status_text(&run.status) == value)
    });
    runs.truncate(limit);
    Ok(runs)
}

fn validate_task_script(script: &str) -> ValidateTaskScriptResult {
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
            warnings: Vec::new(),
        };
    }
    let open_braces = trimmed.chars().filter(|ch| *ch == '{').count();
    let close_braces = trimmed.chars().filter(|ch| *ch == '}').count();
    if open_braces != close_braces {
        return ValidateTaskScriptResult {
            valid: false,
            errors: vec!["Script braces are not balanced".to_string()],
            warnings: Vec::new(),
        };
    }
    ValidateTaskScriptResult {
        valid: true,
        errors: Vec::new(),
        warnings: Vec::new(),
    }
}

async fn page_for_environment(state: &AppState, arguments: &Value) -> AppResult<CdpPage> {
    let environment_id = required_str(arguments, "environment_id")?;
    let status = start_environment_inner(state, environment_id.to_string()).await?;
    let cdp_port = status.cdp_port.ok_or_else(|| {
        AppError::new(
            "cdp_connect_failed",
            "Environment is running but no CDP port is available",
        )
    })?;
    let env = environment_repo::get(state.db(), environment_id)?;
    CdpPage::connect(cdp_port, env.start_url.as_deref()).await
}

fn validate_script(script: &str) -> AppResult<()> {
    deno_runtime::validate_script_surface(script)?;
    Ok(())
}

fn is_terminal_status(status: &TaskRunStatus) -> bool {
    matches!(
        status,
        TaskRunStatus::Succeeded
            | TaskRunStatus::Failed
            | TaskRunStatus::Cancelled
            | TaskRunStatus::TimedOut
            | TaskRunStatus::Interrupted
    )
}

fn run_status_text(status: &TaskRunStatus) -> &'static str {
    match status {
        TaskRunStatus::Queued => "queued",
        TaskRunStatus::Starting => "starting",
        TaskRunStatus::Running => "running",
        TaskRunStatus::CancelRequested => "cancel_requested",
        TaskRunStatus::Succeeded => "succeeded",
        TaskRunStatus::Failed => "failed",
        TaskRunStatus::Cancelled => "cancelled",
        TaskRunStatus::TimedOut => "timed_out",
        TaskRunStatus::Interrupted => "interrupted",
    }
}

fn tool_result(value: Value, is_error: bool) -> AppResult<Value> {
    Ok(json!({
        "content": [{ "type": "text", "text": serde_json::to_string_pretty(&value)? }],
        "isError": is_error
    }))
}

fn tools() -> Vec<Value> {
    vec![
        tool(
            "orbit_get_settings",
            "Read Orbit global settings, including persisted Chrome path and default runtime options.",
            empty_schema(),
        ),
        tool(
            "orbit_save_settings",
            "Update Orbit global settings.",
            json!({
                "type": "object",
                "properties": {
                    "chrome_path": { "type": ["string", "null"] },
                    "default_concurrency": { "type": "integer", "minimum": 1 },
                    "default_locale": { "type": "string" },
                    "default_timezone_id": { "type": "string" },
                    "default_viewport_width": { "type": "integer", "minimum": 320 },
                    "default_viewport_height": { "type": "integer", "minimum": 240 },
                    "aigc_base_url": { "type": ["string", "null"] },
                    "aigc_model": { "type": ["string", "null"] },
                    "aigc_api_key": { "type": ["string", "null"] }
                },
                "required": [
                    "default_concurrency",
                    "default_locale",
                    "default_timezone_id",
                    "default_viewport_width",
                    "default_viewport_height"
                ]
            }),
        ),
        tool(
            "orbit_detect_chrome",
            "Detect installed Chrome, Chromium, or Edge executable candidates.",
            empty_schema(),
        ),
        tool(
            "orbit_get_diagnostics",
            "Read platform diagnostics for Chrome, data directory size, runtime state, recovery, and warnings.",
            empty_schema(),
        ),
        tool(
            "orbit_cleanup_stale_sessions",
            "Remove stale browser session records and profile locks whose processes are no longer alive.",
            empty_schema(),
        ),
        tool(
            "orbit_cleanup_temp_files",
            "Delete Orbit temporary files such as generated proxy-auth extensions.",
            empty_schema(),
        ),
        tool(
            "orbit_list_environments",
            "List Orbit browser environments.",
            empty_schema(),
        ),
        tool(
            "orbit_get_environment",
            "Get one Orbit environment.",
            environment_id_schema(),
        ),
        tool(
            "orbit_save_environment",
            "Create or update an Orbit environment.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": ["string", "null"] },
                    "name": { "type": "string" },
                    "group_id": { "type": ["string", "null"] },
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "notes": { "type": ["string", "null"] },
                    "browser_kind": { "type": "string", "enum": ["chrome", "chromium"] },
                    "chrome_path_override": { "type": ["string", "null"] },
                    "proxy_config": { "type": "object" },
                    "locale": { "type": "string" },
                    "timezone_id": { "type": ["string", "null"] },
                    "geolocation_latitude": { "type": ["number", "null"] },
                    "geolocation_longitude": { "type": ["number", "null"] },
                    "user_agent": { "type": ["string", "null"] },
                    "platform": { "type": ["string", "null"] },
                    "web_rtc_protection": { "type": "boolean" },
                    "viewport_width": { "type": "integer", "minimum": 320 },
                    "viewport_height": { "type": "integer", "minimum": 240 },
                    "device_scale_factor": { "type": "number", "minimum": 0.1 },
                    "environment_mode": { "type": "string", "enum": ["standard", "custom"] },
                    "seed": { "type": ["string", "null"] },
                    "headless": { "type": "boolean" },
                    "start_url": { "type": ["string", "null"] }
                },
                "required": [
                    "name",
                    "tags",
                    "browser_kind",
                    "proxy_config",
                    "locale",
                    "web_rtc_protection",
                    "viewport_width",
                    "viewport_height",
                    "device_scale_factor",
                    "environment_mode",
                    "headless"
                ]
            }),
        ),
        tool(
            "orbit_duplicate_environment",
            "Duplicate one Orbit environment.",
            environment_id_schema(),
        ),
        tool(
            "orbit_delete_environment",
            "Delete one Orbit environment and its related runs, logs, artifacts, and profile files.",
            environment_id_schema(),
        ),
        tool(
            "orbit_start_environment",
            "Start one Orbit environment.",
            environment_id_schema(),
        ),
        tool(
            "orbit_stop_environment",
            "Stop one Orbit environment.",
            environment_id_schema(),
        ),
        tool(
            "orbit_list_tasks",
            "List automation tasks.",
            empty_schema(),
        ),
        tool(
            "orbit_get_task",
            "Get one automation task.",
            task_id_schema(),
        ),
        tool(
            "orbit_save_task",
            "Create or update an automation task.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": ["string", "null"] },
                    "name": { "type": "string" },
                    "description": { "type": ["string", "null"] },
                    "script": { "type": "string" },
                    "timeout_sec": { "type": "integer", "minimum": 5 },
                    "permissions": { "type": "object" }
                },
                "required": ["name", "script", "timeout_sec", "permissions"]
            }),
        ),
        tool(
            "orbit_validate_task_script",
            "Validate an automation task script without saving it.",
            json!({
                "type": "object",
                "properties": {
                    "script": { "type": "string" }
                },
                "required": ["script"]
            }),
        ),
        tool(
            "orbit_delete_task",
            "Delete one automation task and its related run history, logs, and local artifacts.",
            task_id_schema(),
        ),
        tool(
            "orbit_run_task",
            "Queue an automation task for one or more environments and execute it in the background.",
            json!({
                "type": "object",
                "properties": {
                    "task_id": { "type": "string" },
                    "environment_ids": { "type": "array", "items": { "type": "string" } },
                    "options": { "type": "object" }
                },
                "required": ["task_id", "environment_ids"]
            }),
        ),
        tool(
            "orbit_cancel_run",
            "Cancel one queued or active task run.",
            run_id_schema(),
        ),
        tool(
            "orbit_cancel_batch",
            "Cancel queued or active runs in a batch.",
            batch_id_schema(),
        ),
        tool(
            "orbit_retry_run",
            "Create a retry run for an existing task run and execute it in the background.",
            run_id_schema(),
        ),
        tool(
            "orbit_list_runs",
            "List task runs with optional filters.",
            json!({
                "type": "object",
                "properties": {
                    "task_id": { "type": "string" },
                    "environment_id": { "type": "string" },
                    "batch_id": { "type": "string" },
                    "status": {
                        "type": "string",
                        "enum": [
                            "all",
                            "queued",
                            "starting",
                            "running",
                            "cancel_requested",
                            "succeeded",
                            "failed",
                            "cancelled",
                            "timed_out",
                            "interrupted"
                        ],
                        "default": "all"
                    },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 500, "default": 200 }
                }
            }),
        ),
        tool(
            "orbit_get_run",
            "Get one task run.",
            run_id_schema(),
        ),
        tool(
            "orbit_get_run_logs",
            "List logs for a task run.",
            run_id_schema(),
        ),
        tool(
            "orbit_list_run_artifacts",
            "List artifacts for a task run.",
            run_id_schema(),
        ),
        tool(
            "orbit_delete_run",
            "Delete one completed task run and its logs and local artifacts.",
            run_id_schema(),
        ),
        tool(
            "orbit_browser_goto",
            "Navigate an environment browser page to a URL.",
            json!({
                "type": "object",
                "properties": {
                    "environment_id": { "type": "string" },
                    "url": { "type": "string" },
                    "timeout_ms": { "type": "integer", "minimum": 1000 }
                },
                "required": ["environment_id", "url"]
            }),
        ),
        tool(
            "orbit_browser_click",
            "Click a CSS selector in an environment browser page.",
            selector_schema(),
        ),
        tool(
            "orbit_browser_mouse_click",
            "Click page coordinates in an environment browser page.",
            json!({
                "type": "object",
                "properties": {
                    "environment_id": { "type": "string" },
                    "x": { "type": "number", "minimum": 0 },
                    "y": { "type": "number", "minimum": 0 },
                    "button": {
                        "type": "string",
                        "enum": ["left", "middle", "right"],
                        "default": "left"
                    }
                },
                "required": ["environment_id", "x", "y"]
            }),
        ),
        tool(
            "orbit_browser_type",
            "Type text into a CSS selector in an environment browser page.",
            json!({
                "type": "object",
                "properties": {
                    "environment_id": { "type": "string" },
                    "selector": { "type": "string" },
                    "text": { "type": "string" }
                },
                "required": ["environment_id", "selector", "text"]
            }),
        ),
        tool(
            "orbit_browser_wait",
            "Wait for a CSS selector, or wait for milliseconds.",
            json!({
                "type": "object",
                "properties": {
                    "environment_id": { "type": "string" },
                    "selector": { "type": "string" },
                    "milliseconds": { "type": "integer", "minimum": 0 },
                    "timeout_ms": { "type": "integer", "minimum": 1000 }
                },
                "required": ["environment_id"]
            }),
        ),
        tool(
            "orbit_browser_context",
            "Read browser page context: URL, title, visible text, interactive elements, console/network summaries, and optional screenshot.",
            json!({
                "type": "object",
                "properties": {
                    "environment_id": { "type": "string" },
                    "include_screenshot": { "type": "boolean", "default": false }
                },
                "required": ["environment_id"]
            }),
        ),
        tool(
            "orbit_browser_evaluate",
            "Evaluate JavaScript in the environment browser page and return a JSON-serializable value.",
            json!({
                "type": "object",
                "properties": {
                    "environment_id": { "type": "string" },
                    "expression": { "type": "string" }
                },
                "required": ["environment_id", "expression"]
            }),
        ),
        tool(
            "orbit_browser_screenshot",
            "Capture an environment browser page screenshot.",
            environment_id_schema(),
        ),
    ]
}

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": input_schema
    })
}

fn environment_id_schema() -> Value {
    json!({
        "type": "object",
        "properties": { "environment_id": { "type": "string" } },
        "required": ["environment_id"]
    })
}

fn task_id_schema() -> Value {
    json!({
        "type": "object",
        "properties": { "task_id": { "type": "string" } },
        "required": ["task_id"]
    })
}

fn run_id_schema() -> Value {
    json!({
        "type": "object",
        "properties": { "run_id": { "type": "string" } },
        "required": ["run_id"]
    })
}

fn batch_id_schema() -> Value {
    json!({
        "type": "object",
        "properties": { "batch_id": { "type": "string" } },
        "required": ["batch_id"]
    })
}

fn selector_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "environment_id": { "type": "string" },
            "selector": { "type": "string" }
        },
        "required": ["environment_id", "selector"]
    })
}

fn empty_schema() -> Value {
    json!({ "type": "object", "properties": {} })
}

fn required_str<'a>(value: &'a Value, key: &str) -> AppResult<&'a str> {
    value.get(key).and_then(Value::as_str).ok_or_else(|| {
        AppError::new(
            "mcp_invalid_arguments",
            format!("Missing required string argument: {key}"),
        )
    })
}

fn optional_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|item| !item.trim().is_empty())
}

fn required_number(value: &Value, key: &str) -> AppResult<f64> {
    value.get(key).and_then(Value::as_f64).ok_or_else(|| {
        AppError::new(
            "mcp_invalid_arguments",
            format!("Missing required number argument: {key}"),
        )
    })
}

fn timeout_ms(value: &Value, fallback: u64) -> u64 {
    value
        .get("timeout_ms")
        .and_then(Value::as_u64)
        .unwrap_or(fallback)
}

fn write_response(stdout: &mut io::Stdout, payload: Value) -> AppResult<()> {
    writeln!(stdout, "{payload}")
        .and_then(|_| stdout.flush())
        .map_err(|err| AppError::new("mcp_io_error", err.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_include_environment_task_run_and_browser_controls() {
        let names = tools()
            .into_iter()
            .filter_map(|tool| {
                tool.get("name")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            })
            .collect::<Vec<_>>();

        assert!(names.contains(&"orbit_list_environments".to_string()));
        assert!(names.contains(&"orbit_get_settings".to_string()));
        assert!(names.contains(&"orbit_get_diagnostics".to_string()));
        assert!(names.contains(&"orbit_save_environment".to_string()));
        assert!(names.contains(&"orbit_save_task".to_string()));
        assert!(names.contains(&"orbit_validate_task_script".to_string()));
        assert!(names.contains(&"orbit_run_task".to_string()));
        assert!(names.contains(&"orbit_cancel_run".to_string()));
        assert!(names.contains(&"orbit_get_run".to_string()));
        assert!(names.contains(&"orbit_browser_context".to_string()));
        assert!(names.contains(&"orbit_browser_goto".to_string()));
        assert!(names.contains(&"orbit_browser_wait".to_string()));
        assert!(names.contains(&"orbit_browser_mouse_click".to_string()));
        assert!(names.contains(&"orbit_browser_evaluate".to_string()));
        assert!(names.contains(&"orbit_browser_screenshot".to_string()));
    }
}
