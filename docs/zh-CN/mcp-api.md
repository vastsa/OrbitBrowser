# MCP API

Orbit Browser 可以作为本地 MCP stdio server 运行。MCP server 使用与桌面应用相同的
SQLite 数据目录和浏览器 Profile。

```bash
orbit-browser --mcp
```

开发时可以通过 Cargo 启动：

```bash
cargo run --manifest-path src-tauri/Cargo.toml -- --mcp
```

## 工具分组

### 平台能力

- `orbit_get_settings`：读取全局设置。
- `orbit_save_settings`：更新全局设置。
- `orbit_detect_chrome`：检测 Chrome、Chromium 或 Edge。
- `orbit_get_diagnostics`：读取 Chrome、数据目录、运行时、恢复状态和 warning 诊断。
- `orbit_cleanup_stale_sessions`：清理失效 session 记录和 Profile lock。
- `orbit_cleanup_temp_files`：清理临时运行文件。

### 环境管理

- `orbit_list_environments`：列出环境。
- `orbit_get_environment`：读取单个环境。
- `orbit_save_environment`：创建或更新环境。
- `orbit_duplicate_environment`：复制环境。
- `orbit_delete_environment`：删除环境、相关运行记录、产物和 Profile 文件。
- `orbit_start_environment`：启动环境浏览器。
- `orbit_stop_environment`：停止环境浏览器。

### 任务和运行

- `orbit_list_tasks`：列出自动化任务。
- `orbit_get_task`：读取单个任务。
- `orbit_save_task`：创建或更新任务。
- `orbit_validate_task_script`：只校验任务脚本，不保存。
- `orbit_delete_task`：删除任务和相关运行历史。
- `orbit_run_task`：在一个或多个环境上排队任务，并在后台执行。
- `orbit_cancel_run`：取消单个排队中或运行中的 run。
- `orbit_cancel_batch`：取消批次内排队中或运行中的 run。
- `orbit_retry_run`：创建重试 run，并在后台执行。
- `orbit_list_runs`：列出最近运行记录，支持按任务、环境、批次、状态和数量筛选。
- `orbit_get_run`：读取单个运行记录。
- `orbit_get_run_logs`：列出运行日志。
- `orbit_list_run_artifacts`：列出运行产物。
- `orbit_delete_run`：删除已完成运行记录和本地产物。

### 浏览器页面控制

- `orbit_browser_goto`：导航页面。
- `orbit_browser_click`：点击 CSS selector。
- `orbit_browser_mouse_click`：点击页面坐标。
- `orbit_browser_type`：向 CSS selector 输入文本。
- `orbit_browser_wait`：等待 selector 或指定毫秒数。
- `orbit_browser_context`：读取 URL、标题、可见文本、可交互元素、console/network 摘要和可选截图。
- `orbit_browser_evaluate`：执行 JavaScript 并返回可 JSON 序列化的值。
- `orbit_browser_screenshot`：捕获 PNG 截图并以 base64 返回。

## 错误处理

MCP 协议错误会返回 JSON-RPC error。工具执行错误会作为普通 `tools/call` 结果返回，
并带有 `isError: true` 和 JSON payload：

```json
{
  "code": "mcp_invalid_arguments",
  "message": "Missing required string argument: environment_id",
  "details": null,
  "retryable": false
}
```

这样 MCP client 可以区分协议失败和普通 Orbit 业务错误，例如环境不存在、运行记录仍在执行、
或 Chrome 启动失败。

## 任务执行模型

`orbit_run_task` 会在创建 batch 和 queued runs 后返回，任务会继续在 MCP server 进程中后台执行。
客户端应通过 `orbit_list_runs`、`orbit_get_run_logs` 和 `orbit_list_run_artifacts` 轮询进度并读取结果。
运行仍处于 queued 或 active 状态时，可以使用 `orbit_cancel_run` 或 `orbit_cancel_batch` 请求取消。
