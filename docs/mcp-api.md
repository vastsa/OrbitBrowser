# MCP API

Orbit Browser can run as a local MCP stdio server. The server uses the same
SQLite data directory and browser profiles as the desktop app.

```bash
orbit-browser --mcp
```

For development, run it through Cargo:

```bash
cargo run --manifest-path src-tauri/Cargo.toml -- --mcp
```

## Tool Groups

### Platform

- `orbit_get_settings`: read global settings.
- `orbit_save_settings`: update global settings.
- `orbit_detect_chrome`: detect Chrome, Chromium, or Edge.
- `orbit_get_diagnostics`: read Chrome, data, runtime, recovery, and warning diagnostics.
- `orbit_cleanup_stale_sessions`: remove stale session records and profile locks.
- `orbit_cleanup_temp_files`: remove temporary runtime files.

### Environments

- `orbit_list_environments`: list environments.
- `orbit_get_environment`: read one environment.
- `orbit_save_environment`: create or update an environment.
- `orbit_duplicate_environment`: duplicate an environment.
- `orbit_delete_environment`: delete an environment, related runs, artifacts, and profile files.
- `orbit_start_environment`: start an environment browser.
- `orbit_stop_environment`: stop an environment browser.

### Tasks And Runs

- `orbit_list_tasks`: list saved automation tasks.
- `orbit_get_task`: read one task.
- `orbit_save_task`: create or update a task.
- `orbit_validate_task_script`: validate a task script without saving.
- `orbit_delete_task`: delete a task and related run history.
- `orbit_run_task`: queue a task on one or more environments and execute it in the background.
- `orbit_cancel_run`: cancel one queued or active run.
- `orbit_cancel_batch`: cancel queued or active runs in a batch.
- `orbit_retry_run`: create a retry run and execute it in the background.
- `orbit_list_runs`: list recent runs, optionally filtered by task, environment, batch, status, and limit.
- `orbit_get_run`: read one run.
- `orbit_get_run_logs`: list run logs.
- `orbit_list_run_artifacts`: list run artifacts.
- `orbit_delete_run`: delete a completed run and its local artifacts.

### Browser Page Control

- `orbit_browser_goto`: navigate a page.
- `orbit_browser_click`: click a CSS selector.
- `orbit_browser_mouse_click`: click page coordinates.
- `orbit_browser_type`: type text into a CSS selector.
- `orbit_browser_wait`: wait for a selector or for milliseconds.
- `orbit_browser_context`: read URL, title, visible text, interactive elements, console/network summaries, and optional screenshot.
- `orbit_browser_evaluate`: evaluate JavaScript and return a JSON-serializable value.
- `orbit_browser_screenshot`: capture a PNG screenshot as base64.

## Error Handling

MCP protocol errors are returned as JSON-RPC errors. Tool execution errors are
returned as normal `tools/call` results with `isError: true` and a JSON payload:

```json
{
  "code": "mcp_invalid_arguments",
  "message": "Missing required string argument: environment_id",
  "details": null,
  "retryable": false
}
```

This lets MCP clients distinguish protocol failures from normal Orbit business
errors such as missing environments, active runs, or Chrome startup failures.

## Task Execution Model

`orbit_run_task` returns after it creates a batch and queued runs. Execution
continues in the MCP server process. Clients should poll `orbit_list_runs`,
`orbit_get_run_logs`, and `orbit_list_run_artifacts` to follow progress and
collect results. Use `orbit_cancel_run` or `orbit_cancel_batch` to request
cancellation while runs are still queued or active.
