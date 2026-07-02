use crate::app_state::AppState;
use crate::automation::{cancellation::CancellationToken, deno_runtime, task_runner};
use crate::browser::cdp_client::CdpPage;
use crate::commands::environments::{start_environment_inner, stop_environment_inner};
use crate::domain::run::RunTaskInput;
use crate::domain::task::SaveTaskInput;
use crate::errors::{AppError, AppResult};
use crate::storage::{artifact_repo, environment_repo, log_repo, run_repo, task_repo};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

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
            let value = call_tool(state, name, arguments).await?;
            Ok(json!({
                "content": [{ "type": "text", "text": serde_json::to_string_pretty(&value)? }],
                "isError": false
            }))
        }
        _ => Err(AppError::new(
            "mcp_method_not_found",
            format!("Unsupported MCP method: {}", request.method),
        )),
    }
}

async fn call_tool(state: AppState, name: &str, arguments: Value) -> AppResult<Value> {
    match name {
        "orbit_list_environments" => Ok(json!(environment_repo::list(state.db())?)),
        "orbit_get_environment" => {
            let environment_id = required_str(&arguments, "environment_id")?;
            Ok(json!(environment_repo::get(state.db(), environment_id)?))
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
        "orbit_save_task" => {
            let input: SaveTaskInput = serde_json::from_value(arguments)?;
            validate_script(&input.script)?;
            Ok(json!(task_repo::save(state.db(), input)?))
        }
        "orbit_run_task" => run_task(state, arguments).await,
        "orbit_list_runs" => Ok(json!(run_repo::list_runs(state.db())?)),
        "orbit_get_run_logs" => {
            let run_id = required_str(&arguments, "run_id")?;
            Ok(json!(log_repo::list(state.db(), run_id)?))
        }
        "orbit_list_run_artifacts" => {
            let run_id = required_str(&arguments, "run_id")?;
            Ok(json!(artifact_repo::list(state.db(), run_id)?))
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
    let runs = run_repo::list_runs_by_batch(state.db(), &batch.id)?;

    for run in runs {
        let token = CancellationToken::default();
        let _ = task_runner::execute_task_run(
            state.clone(),
            None,
            run,
            task.clone(),
            options.clone(),
            token,
        )
        .await;
    }

    Ok(json!({
        "batch": run_repo::get_batch(state.db(), &batch.id)?,
        "runs": run_repo::list_runs_by_batch(state.db(), &batch.id)?
    }))
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

fn tools() -> Vec<Value> {
    vec![
        tool(
            "orbit_list_environments",
            "List Orbit browser environments.",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "orbit_get_environment",
            "Get one Orbit environment.",
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
            json!({ "type": "object", "properties": {} }),
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
            "orbit_run_task",
            "Run an automation task for one or more environments.",
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
            "orbit_list_runs",
            "List task runs.",
            json!({ "type": "object", "properties": {} }),
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

fn run_id_schema() -> Value {
    json!({
        "type": "object",
        "properties": { "run_id": { "type": "string" } },
        "required": ["run_id"]
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

fn required_str<'a>(value: &'a Value, key: &str) -> AppResult<&'a str> {
    value.get(key).and_then(Value::as_str).ok_or_else(|| {
        AppError::new(
            "mcp_invalid_arguments",
            format!("Missing required string argument: {key}"),
        )
    })
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
        assert!(names.contains(&"orbit_save_task".to_string()));
        assert!(names.contains(&"orbit_run_task".to_string()));
        assert!(names.contains(&"orbit_browser_context".to_string()));
        assert!(names.contains(&"orbit_browser_goto".to_string()));
        assert!(names.contains(&"orbit_browser_wait".to_string()));
        assert!(names.contains(&"orbit_browser_mouse_click".to_string()));
        assert!(names.contains(&"orbit_browser_evaluate".to_string()));
        assert!(names.contains(&"orbit_browser_screenshot".to_string()));
    }
}
