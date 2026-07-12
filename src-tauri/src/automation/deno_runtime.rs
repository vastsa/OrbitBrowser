use crate::app_state::AppState;
use crate::automation::cancellation::CancellationToken;
use crate::automation::permissions::TaskPermissions;
use crate::browser::cdp_client::PageSnapshot;
use crate::browser::runtime_page::BrowserPage;
use crate::browser::timezone_controller;
use crate::domain::artifact::RunArtifact;
use crate::domain::environment::{BrowserKind, Environment};
use crate::domain::run::{RunLog, TaskRun};
use crate::errors::{AppError, AppResult};
use crate::storage::{artifact_repo, log_repo};
use deno_core::{extension, op2, resolve_url, JsRuntime, OpState, RuntimeOptions};
use deno_error::JsErrorBox;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct ScriptRuntimeContext {
    inner: Arc<Mutex<ScriptRuntimeState>>,
    env_json: Arc<Value>,
}

pub struct ScriptRuntimeInput {
    pub state: AppState,
    pub app: Option<AppHandle>,
    pub run: TaskRun,
    pub script: String,
    pub environment: Environment,
    pub permissions: TaskPermissions,
    pub cdp_port: u16,
    pub artifacts_dir: PathBuf,
    pub cancellation: CancellationToken,
    pub timeout: Duration,
}

struct ScriptRuntimeState {
    state: AppState,
    app: Option<AppHandle>,
    run: TaskRun,
    environment: Environment,
    permissions: TaskPermissions,
    page: Option<BrowserPage>,
    cdp_port: u16,
    artifacts_dir: PathBuf,
    cancellation: CancellationToken,
}

extension!(
    orbit_runtime,
    ops = [
        op_orbit_env,
        op_orbit_page_goto,
        op_orbit_page_click,
        op_orbit_page_type,
        op_orbit_page_wait,
        op_orbit_page_evaluate,
        op_orbit_page_title,
        op_orbit_page_url,
        op_orbit_page_screenshot,
        op_orbit_log,
        op_orbit_output_json,
        op_orbit_output_text,
        op_orbit_sleep,
    ],
    options = {
        context: ScriptRuntimeContext,
    },
    state = |state, options| {
        state.put(options.context);
    }
);

pub async fn execute_script(input: ScriptRuntimeInput) -> AppResult<PageSnapshot> {
    let timeout = input.timeout;
    let cancellation = input.cancellation.clone();
    let join = tokio::task::spawn_blocking(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|err| AppError::new("script_runtime_error", err.to_string()))?;
        runtime.block_on(execute_script_on_local_runtime(input))
    });

    match tokio::time::timeout(timeout + Duration::from_secs(2), join).await {
        Ok(Ok(result)) => result,
        Ok(Err(err)) => Err(AppError::new(
            "script_runtime_error",
            format!("Script thread failed: {err}"),
        )),
        Err(_) => {
            cancellation.cancel();
            Err(AppError::new("task_timeout", "Task execution timed out").retryable(true))
        }
    }
}

async fn execute_script_on_local_runtime(input: ScriptRuntimeInput) -> AppResult<PageSnapshot> {
    let ScriptRuntimeInput {
        state,
        app,
        run,
        script,
        environment,
        permissions,
        cdp_port,
        artifacts_dir,
        cancellation,
        timeout,
    } = input;

    let env_json = environment_json(&environment);
    let mut page = connect_runtime_page(&environment, cdp_port).await?;
    apply_environment_overrides(&mut page, &environment).await?;
    let context = ScriptRuntimeContext {
        inner: Arc::new(Mutex::new(ScriptRuntimeState {
            state,
            app,
            run: run.clone(),
            environment,
            permissions,
            page: None,
            cdp_port,
            artifacts_dir,
            cancellation: cancellation.clone(),
        })),
        env_json: Arc::new(env_json),
    };

    page.snapshot().await?;
    {
        let mut guard = context.inner.lock().await;
        guard.page = Some(page);
    }

    let mut runtime = JsRuntime::new(RuntimeOptions {
        extensions: vec![orbit_runtime::init(context.clone())],
        ..Default::default()
    });
    runtime
        .execute_script("orbit_bootstrap.js", bootstrap_script())
        .map_err(app_error_from_runtime)?;

    let terminated = Arc::new(AtomicBool::new(false));
    let finished = Arc::new(AtomicBool::new(false));
    let monitor = spawn_termination_monitor(
        runtime.v8_isolate().thread_safe_handle(),
        cancellation.clone(),
        timeout,
        terminated.clone(),
        finished.clone(),
    );

    let module = resolve_url("file:///orbit-task.js")
        .map_err(|err| AppError::new("script_runtime_error", err.to_string()))?;
    let task_source = wrap_script_source(&script);
    let module_id = runtime
        .load_main_es_module_from_code(&module, task_source)
        .await
        .map_err(app_error_from_runtime)?;
    let evaluation = runtime.mod_evaluate(module_id);
    let event_loop_result = runtime.run_event_loop(Default::default()).await;
    finished.store(true, Ordering::SeqCst);
    let _ = monitor.join();

    if cancellation.is_cancelled() {
        return Err(AppError::new("task_cancelled", "Task was cancelled"));
    }
    if terminated.load(Ordering::SeqCst) {
        return Err(AppError::new("task_timeout", "Task execution timed out").retryable(true));
    }

    event_loop_result.map_err(app_error_from_runtime)?;
    evaluation.await.map_err(app_error_from_runtime)?;

    let mut guard = context.inner.lock().await;
    guard.ensure_not_cancelled()?;
    let page = guard
        .page
        .as_mut()
        .ok_or_else(|| AppError::new("script_runtime_error", "Page context has been released"))?;
    page.snapshot().await
}

async fn apply_environment_overrides(
    page: &mut BrowserPage,
    environment: &Environment,
) -> AppResult<()> {
    let timezone_id = page_timezone_id(environment);
    let geolocation = page_geolocation(environment);
    apply_page_overrides(page, timezone_id.as_deref(), geolocation).await
}

async fn apply_page_overrides(
    page: &mut BrowserPage,
    timezone_id: Option<&str>,
    geolocation: Option<(f64, f64, f64)>,
) -> AppResult<()> {
    if let Some(timezone_id) = timezone_id {
        page.set_timezone_override(timezone_id).await?;
    }
    if let Some((latitude, longitude, accuracy)) = geolocation {
        page.set_geolocation_override(latitude, longitude, accuracy)
            .await?;
    }
    Ok(())
}

async fn connect_runtime_page(environment: &Environment, port: u16) -> AppResult<BrowserPage> {
    if matches!(environment.browser_kind, BrowserKind::Camoufox) {
        BrowserPage::connect_camoufox(port).await
    } else {
        BrowserPage::connect_cdp(port, environment.start_url.as_deref()).await
    }
}

fn page_timezone_id(environment: &Environment) -> Option<String> {
    environment
        .timezone_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "auto")
        .map(str::to_string)
}

fn page_geolocation(environment: &Environment) -> Option<(f64, f64, f64)> {
    Some((
        environment.geolocation_latitude?,
        environment.geolocation_longitude?,
        20.0,
    ))
}

#[op2]
#[serde]
fn op_orbit_env(op_state: Rc<RefCell<OpState>>) -> Result<serde_json::Value, JsErrorBox> {
    Ok(runtime_context(&op_state).env_json.as_ref().clone())
}

#[op2]
async fn op_orbit_page_goto(
    op_state: Rc<RefCell<OpState>>,
    #[string] url: String,
    #[serde] options: Option<serde_json::Value>,
) -> Result<(), JsErrorBox> {
    let context = runtime_context(&op_state);
    let timeout = option_timeout(&options, 30_000);
    let mut guard = context.inner.lock().await;
    guard.ensure_not_cancelled().map_err(js_error)?;
    guard
        .append_log("info", &format!("Opening page: {url}"), None)
        .map_err(js_error)?;
    let timezone_id = page_timezone_id(&guard.environment);
    let geolocation = page_geolocation(&guard.environment);
    if geolocation.is_some() && !matches!(guard.environment.browser_kind, BrowserKind::Camoufox) {
        timezone_controller::grant_geolocation_permission(guard.cdp_port, &url)
            .await
            .map_err(js_error)?;
    }
    guard
        .page_mut()
        .map_err(js_error)?
        .goto(&url, Duration::from_millis(timeout))
        .await
        .map_err(js_error)?;
    if geolocation.is_some() && !matches!(guard.environment.browser_kind, BrowserKind::Camoufox) {
        timezone_controller::grant_geolocation_permission(guard.cdp_port, &url)
            .await
            .map_err(js_error)?;
    }
    apply_page_overrides(
        guard.page_mut().map_err(js_error)?,
        timezone_id.as_deref(),
        geolocation,
    )
    .await
    .map_err(js_error)?;
    Ok(())
}

#[op2]
async fn op_orbit_page_click(
    op_state: Rc<RefCell<OpState>>,
    #[string] selector: String,
    #[serde] _options: Option<serde_json::Value>,
) -> Result<(), JsErrorBox> {
    let context = runtime_context(&op_state);
    let mut guard = context.inner.lock().await;
    guard.ensure_not_cancelled().map_err(js_error)?;
    guard
        .page_mut()
        .map_err(js_error)?
        .click(&selector)
        .await
        .map_err(js_error)?;
    guard
        .append_log("debug", &format!("Clicked element: {selector}"), None)
        .map_err(js_error)?;
    Ok(())
}

#[op2]
async fn op_orbit_page_type(
    op_state: Rc<RefCell<OpState>>,
    #[string] selector: String,
    #[string] text: String,
    #[serde] _options: Option<serde_json::Value>,
) -> Result<(), JsErrorBox> {
    let context = runtime_context(&op_state);
    let mut guard = context.inner.lock().await;
    guard.ensure_not_cancelled().map_err(js_error)?;
    guard
        .page_mut()
        .map_err(js_error)?
        .type_text(&selector, &text)
        .await
        .map_err(js_error)?;
    guard
        .append_log("debug", &format!("Typed text into: {selector}"), None)
        .map_err(js_error)?;
    Ok(())
}

#[op2]
async fn op_orbit_page_wait(
    op_state: Rc<RefCell<OpState>>,
    #[serde] target: serde_json::Value,
    #[serde] options: Option<serde_json::Value>,
) -> Result<(), JsErrorBox> {
    let context = runtime_context(&op_state);
    let timeout = option_timeout(&options, 10_000);
    let mut guard = context.inner.lock().await;
    guard.ensure_not_cancelled().map_err(js_error)?;
    if let Some(ms) = target.as_u64() {
        drop(guard);
        tokio::time::sleep(Duration::from_millis(ms)).await;
        return Ok(());
    }
    let selector = target.as_str().ok_or_else(|| {
        JsErrorBox::type_error("page.wait only accepts milliseconds or a selector")
    })?;
    guard
        .page_mut()
        .map_err(js_error)?
        .wait_for_selector(selector, Duration::from_millis(timeout))
        .await
        .map_err(js_error)?;
    Ok(())
}

#[op2]
#[serde]
async fn op_orbit_page_evaluate(
    op_state: Rc<RefCell<OpState>>,
    #[string] expression: String,
) -> Result<serde_json::Value, JsErrorBox> {
    let context = runtime_context(&op_state);
    let mut guard = context.inner.lock().await;
    guard.ensure_not_cancelled().map_err(js_error)?;
    guard
        .page_mut()
        .map_err(js_error)?
        .evaluate(&expression)
        .await
        .map_err(js_error)
}

#[op2]
#[string]
async fn op_orbit_page_title(op_state: Rc<RefCell<OpState>>) -> Result<String, JsErrorBox> {
    let context = runtime_context(&op_state);
    let mut guard = context.inner.lock().await;
    guard.ensure_not_cancelled().map_err(js_error)?;
    guard
        .page_mut()
        .map_err(js_error)?
        .title()
        .await
        .map_err(js_error)
}

#[op2]
#[string]
async fn op_orbit_page_url(op_state: Rc<RefCell<OpState>>) -> Result<String, JsErrorBox> {
    let context = runtime_context(&op_state);
    let mut guard = context.inner.lock().await;
    guard.ensure_not_cancelled().map_err(js_error)?;
    guard
        .page_mut()
        .map_err(js_error)?
        .url()
        .await
        .map_err(js_error)
}

#[op2]
async fn op_orbit_page_screenshot(
    op_state: Rc<RefCell<OpState>>,
    #[string] label: String,
    #[serde] _options: Option<serde_json::Value>,
) -> Result<(), JsErrorBox> {
    let context = runtime_context(&op_state);
    let mut guard = context.inner.lock().await;
    guard.ensure_not_cancelled().map_err(js_error)?;
    let png = guard
        .page_mut()
        .map_err(js_error)?
        .screenshot_png()
        .await
        .map_err(js_error)?;
    guard.write_screenshot(&label, png).map_err(js_error)?;
    Ok(())
}

#[op2]
async fn op_orbit_log(
    op_state: Rc<RefCell<OpState>>,
    #[string] level: String,
    #[string] message: String,
) -> Result<(), JsErrorBox> {
    let context = runtime_context(&op_state);
    let guard = context.inner.lock().await;
    guard.ensure_not_cancelled().map_err(js_error)?;
    guard.append_log(&level, &message, None).map_err(js_error)?;
    Ok(())
}

#[op2]
async fn op_orbit_output_json(
    op_state: Rc<RefCell<OpState>>,
    #[string] label: String,
    #[serde] data: serde_json::Value,
) -> Result<(), JsErrorBox> {
    let context = runtime_context(&op_state);
    let guard = context.inner.lock().await;
    guard.ensure_not_cancelled().map_err(js_error)?;
    guard.write_json_output(&label, &data).map_err(js_error)?;
    Ok(())
}

#[op2]
async fn op_orbit_output_text(
    op_state: Rc<RefCell<OpState>>,
    #[string] label: String,
    #[string] text: String,
) -> Result<(), JsErrorBox> {
    let context = runtime_context(&op_state);
    let guard = context.inner.lock().await;
    guard.ensure_not_cancelled().map_err(js_error)?;
    guard.write_text_output(&label, &text).map_err(js_error)?;
    Ok(())
}

#[op2]
async fn op_orbit_sleep(
    op_state: Rc<RefCell<OpState>>,
    #[smi] milliseconds: u32,
) -> Result<(), JsErrorBox> {
    let context = runtime_context(&op_state);
    {
        let guard = context.inner.lock().await;
        guard.ensure_not_cancelled().map_err(js_error)?;
    }
    tokio::time::sleep(Duration::from_millis(milliseconds as u64)).await;
    {
        let guard = context.inner.lock().await;
        guard.ensure_not_cancelled().map_err(js_error)?;
    }
    Ok(())
}

impl ScriptRuntimeState {
    fn page_mut(&mut self) -> AppResult<&mut BrowserPage> {
        self.page
            .as_mut()
            .ok_or_else(|| AppError::new("script_runtime_error", "Page context is unavailable"))
    }

    fn ensure_not_cancelled(&self) -> AppResult<()> {
        if self.cancellation.is_cancelled() {
            Err(AppError::new("task_cancelled", "Task was cancelled"))
        } else {
            Ok(())
        }
    }

    fn append_log(&self, level: &str, message: &str, data: Option<Value>) -> AppResult<RunLog> {
        let normalized_level = match level {
            "trace" | "debug" | "info" | "warn" | "error" => level,
            _ => "info",
        };
        let log = log_repo::append(
            self.state.db(),
            &self.run.id,
            normalized_level,
            message,
            data,
        )?;
        if let Some(app) = &self.app {
            let _ = app.emit("run_log_appended", &log);
        }
        Ok(log)
    }

    fn write_screenshot(&self, label: &str, png: Vec<u8>) -> AppResult<()> {
        let safe_label = safe_label(label);
        let relative_path = format!("runs/{}/screenshots/{safe_label}.png", self.run.id);
        let absolute_path = self.state.data_dir().join(&relative_path);
        if let Some(parent) = absolute_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&absolute_path, png)?;
        self.create_artifact("screenshot", label, &relative_path)?;
        self.append_log(
            "info",
            &format!("Screenshot saved: {label}"),
            Some(json!({ "path": relative_path })),
        )?;
        Ok(())
    }

    fn write_json_output(&self, label: &str, data: &Value) -> AppResult<()> {
        let safe_label = safe_label(label);
        let relative_path = format!("runs/{}/artifacts/{safe_label}.json", self.run.id);
        let absolute_path = self
            .artifacts_dir
            .join("artifacts")
            .join(format!("{safe_label}.json"));
        write_json_file(&absolute_path, data)?;
        self.create_artifact("json", label, &relative_path)?;
        Ok(())
    }

    fn write_text_output(&self, label: &str, text: &str) -> AppResult<()> {
        let safe_label = safe_label(label);
        let relative_path = format!("runs/{}/artifacts/{safe_label}.txt", self.run.id);
        let absolute_path = self
            .artifacts_dir
            .join("artifacts")
            .join(format!("{safe_label}.txt"));
        if let Some(parent) = absolute_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&absolute_path, text)?;
        self.create_artifact("text", label, &relative_path)?;
        Ok(())
    }

    fn create_artifact(&self, kind: &str, label: &str, path: &str) -> AppResult<RunArtifact> {
        let artifact = artifact_repo::create(self.state.db(), &self.run.id, kind, label, path)?;
        if let Some(app) = &self.app {
            let _ = app.emit("run_artifact_created", &artifact);
        }
        Ok(artifact)
    }
}

fn wildcard_match(pattern: &str, value: &str) -> bool {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return false;
    }
    if pattern == "*" || pattern == "<all_urls>" {
        return true;
    }
    if !pattern.contains('*') {
        return pattern == value;
    }

    let mut remaining = value;
    let starts_with_wildcard = pattern.starts_with('*');
    let ends_with_wildcard = pattern.ends_with('*');
    let parts = pattern.split('*').filter(|part| !part.is_empty());
    let mut first = true;

    for part in parts {
        if first && !starts_with_wildcard {
            if !remaining.starts_with(part) {
                return false;
            }
            remaining = &remaining[part.len()..];
        } else if let Some(index) = remaining.find(part) {
            remaining = &remaining[index + part.len()..];
        } else {
            return false;
        }
        first = false;
    }

    ends_with_wildcard || remaining.is_empty()
}

fn runtime_context(op_state: &Rc<RefCell<OpState>>) -> ScriptRuntimeContext {
    let op_state = op_state.borrow();
    op_state.borrow::<ScriptRuntimeContext>().clone()
}

fn spawn_termination_monitor(
    isolate: deno_core::v8::IsolateHandle,
    cancellation: CancellationToken,
    timeout: Duration,
    terminated: Arc<AtomicBool>,
    finished: Arc<AtomicBool>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let deadline = Instant::now() + timeout;
        while !finished.load(Ordering::SeqCst) {
            if cancellation.is_cancelled() || Instant::now() >= deadline {
                terminated.store(true, Ordering::SeqCst);
                let _ = isolate.terminate_execution();
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    })
}

fn wrap_script_source(script: &str) -> String {
    script.to_string()
}

fn environment_json(environment: &Environment) -> Value {
    json!({
        "id": &environment.id,
        "name": &environment.name,
        "groupId": &environment.group_id,
        "tags": &environment.tags,
        "notes": &environment.notes,
        "locale": &environment.locale,
        "timezoneId": &environment.timezone_id,
        "geolocation": {
            "latitude": environment.geolocation_latitude,
            "longitude": environment.geolocation_longitude
        },
        "identity": {
            "userAgent": &environment.user_agent,
            "platform": &environment.platform,
            "webRtcProtection": environment.web_rtc_protection
        },
        "viewport": {
            "width": environment.viewport_width,
            "height": environment.viewport_height,
            "deviceScaleFactor": environment.device_scale_factor
        },
        "proxy": {
            "kind": &environment.proxy_config.kind,
            "host": &environment.proxy_config.host,
            "port": environment.proxy_config.port,
            "hasAuth": environment.proxy_config.has_auth()
        }
    })
}

fn bootstrap_script() -> &'static str {
    r#"
(() => {
  const ops = Deno.core.ops;
  const coerceOptions = (value) => value && typeof value === "object" ? value : {};
  const pageApi = Object.freeze({
    goto: (url, options = {}) => ops.op_orbit_page_goto(String(url), coerceOptions(options)),
    click: (selector, options = {}) => ops.op_orbit_page_click(String(selector), coerceOptions(options)),
    type: (selector, text, options = {}) => ops.op_orbit_page_type(String(selector), String(text ?? ""), coerceOptions(options)),
    wait: (target, options = {}) => ops.op_orbit_page_wait(target, coerceOptions(options)),
    evaluate: (expression) => ops.op_orbit_page_evaluate(String(expression)),
    title: () => ops.op_orbit_page_title(),
    url: () => ops.op_orbit_page_url(),
    screenshot: (label = "screenshot", options = {}) => ops.op_orbit_page_screenshot(String(label), coerceOptions(options)),
  });
  const logApi = Object.freeze({
    trace: (message) => ops.op_orbit_log("trace", String(message ?? "")),
    debug: (message) => ops.op_orbit_log("debug", String(message ?? "")),
    info: (message) => ops.op_orbit_log("info", String(message ?? "")),
    warn: (message) => ops.op_orbit_log("warn", String(message ?? "")),
    error: (message) => ops.op_orbit_log("error", String(message ?? "")),
  });
  const runApi = Object.freeze({
    outputJson: (label = "result", data = null) => ops.op_orbit_output_json(String(label), data),
    outputText: (label = "output", text = "") => ops.op_orbit_output_text(String(label), String(text ?? "")),
  });
  const orbit = Object.freeze({
    page: pageApi,
    log: logApi,
    run: runApi,
    env: Object.freeze(ops.op_orbit_env()),
    sleep: (ms) => ops.op_orbit_sleep(Math.max(0, Number(ms) || 0)),
  });
  Object.defineProperty(globalThis, "orbit", { value: orbit, writable: false, configurable: false });
  Object.defineProperty(globalThis, "page", { value: orbit.page, writable: false, configurable: false });
  Object.defineProperty(globalThis, "log", { value: orbit.log, writable: false, configurable: false });
  Object.defineProperty(globalThis, "run", { value: orbit.run, writable: false, configurable: false });
  Object.defineProperty(globalThis, "env", { value: orbit.env, writable: false, configurable: false });
  Object.defineProperty(globalThis, "sleep", { value: orbit.sleep, writable: false, configurable: false });
})();
"#
}

pub fn validate_script_surface(script: &str) -> AppResult<()> {
    let trimmed = script.trim();
    if trimmed.is_empty() {
        return Err(AppError::new(
            "script_compile_error",
            "Script cannot be empty",
        ));
    }

    // 静态结构检查：引号/模板字符串/注释内的括号不参与平衡判断
    validate_script_structure(trimmed)?;

    // 真实语法编译：只加载模块，不执行，避免触发 page/log 副作用
    validate_script_syntax(trimmed)?;
    Ok(())
}

/// 收集不阻塞保存的提示信息
pub fn collect_script_warnings(script: &str) -> Vec<String> {
    let trimmed = script.trim();
    let mut warnings = Vec::new();
    if trimmed.is_empty() {
        return warnings;
    }

    let lowered = trimmed.to_ascii_lowercase();
    let uses_page = lowered.contains("page.") || lowered.contains("orbit.page");
    let uses_log = lowered.contains("log.") || lowered.contains("orbit.log");
    let uses_run = lowered.contains("run.") || lowered.contains("orbit.run");
    let uses_sleep = lowered.contains("sleep(") || lowered.contains("orbit.sleep");

    if !(uses_page || uses_log || uses_run || uses_sleep) {
        warnings.push(
            "Script does not call page/log/run/sleep APIs; confirm this is intentional"
                .to_string(),
        );
    }

    if uses_page
        && !lowered.contains("await page.")
        && !lowered.contains("await orbit.page.")
    {
        warnings.push(
            "page APIs are async; prefer `await page.xxx(...)` to avoid race conditions"
                .to_string(),
        );
    }

    if trimmed.lines().count() > 400 {
        warnings.push("Script is quite long; consider splitting into smaller tasks".to_string());
    }

    warnings
}

fn validate_script_structure(script: &str) -> AppResult<()> {
    let mut stack: Vec<(char, usize, usize)> = Vec::new();
    let mut line = 1usize;
    let mut col = 0usize;
    let mut chars = script.chars().peekable();
    let mut in_single = false;
    let mut in_double = false;
    let mut in_template = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    // `${ ... }` 表达式内部的花括号嵌套深度
    let mut template_expr_depth = 0usize;

    while let Some(ch) = chars.next() {
        if ch == '\n' {
            line += 1;
            col = 0;
            if in_line_comment {
                in_line_comment = false;
            }
            continue;
        }
        col += 1;

        if in_line_comment {
            continue;
        }
        if in_block_comment {
            if ch == '*' && chars.peek() == Some(&'/') {
                let _ = chars.next();
                col += 1;
                in_block_comment = false;
            }
            continue;
        }

        if in_single {
            if ch == '\\' {
                if chars.next().is_some() {
                    col += 1;
                }
            } else if ch == '\'' {
                in_single = false;
            }
            continue;
        }
        if in_double {
            if ch == '\\' {
                if chars.next().is_some() {
                    col += 1;
                }
            } else if ch == '"' {
                in_double = false;
            }
            continue;
        }

        // 模板字符串字面量主体（不在 ${} 中）
        if in_template && template_expr_depth == 0 {
            if ch == '\\' {
                if chars.next().is_some() {
                    col += 1;
                }
            } else if ch == '`' {
                in_template = false;
            } else if ch == '$' && chars.peek() == Some(&'{') {
                let _ = chars.next();
                col += 1;
                template_expr_depth = 1;
                stack.push(('{', line, col));
            }
            continue;
        }

        match ch {
            '/' => match chars.peek().copied() {
                Some('/') => {
                    let _ = chars.next();
                    col += 1;
                    in_line_comment = true;
                }
                Some('*') => {
                    let _ = chars.next();
                    col += 1;
                    in_block_comment = true;
                }
                _ => {}
            },
            '\'' => in_single = true,
            '"' => in_double = true,
            '`' if template_expr_depth == 0 => in_template = true,
            '{' => {
                stack.push(('{', line, col));
                if template_expr_depth > 0 {
                    template_expr_depth += 1;
                }
            }
            '}' => match stack.pop() {
                Some(('{', _, _)) => {
                    if template_expr_depth > 0 {
                        template_expr_depth -= 1;
                    }
                }
                Some((open, open_line, open_col)) => {
                    return Err(AppError::new(
                        "script_compile_error",
                        format!(
                            "Mismatched `}}` at {line}:{col}; nearest open `{open}` at {open_line}:{open_col}"
                        ),
                    ));
                }
                None => {
                    return Err(AppError::new(
                        "script_compile_error",
                        format!("Unexpected `}}` at {line}:{col}"),
                    ));
                }
            },
            '(' => stack.push(('(', line, col)),
            ')' => match stack.pop() {
                Some(('(', _, _)) => {}
                Some((open, open_line, open_col)) => {
                    return Err(AppError::new(
                        "script_compile_error",
                        format!(
                            "Mismatched `)` at {line}:{col}; nearest open `{open}` at {open_line}:{open_col}"
                        ),
                    ));
                }
                None => {
                    return Err(AppError::new(
                        "script_compile_error",
                        format!("Unexpected `)` at {line}:{col}"),
                    ));
                }
            },
            '[' => stack.push(('[', line, col)),
            ']' => match stack.pop() {
                Some(('[', _, _)) => {}
                Some((open, open_line, open_col)) => {
                    return Err(AppError::new(
                        "script_compile_error",
                        format!(
                            "Mismatched `]` at {line}:{col}; nearest open `{open}` at {open_line}:{open_col}"
                        ),
                    ));
                }
                None => {
                    return Err(AppError::new(
                        "script_compile_error",
                        format!("Unexpected `]` at {line}:{col}"),
                    ));
                }
            },
            _ => {}
        }
    }

    if in_single || in_double || in_template {
        return Err(AppError::new(
            "script_compile_error",
            "Unterminated string or template literal",
        ));
    }
    if in_block_comment {
        return Err(AppError::new(
            "script_compile_error",
            "Unterminated block comment",
        ));
    }
    if let Some((open, open_line, open_col)) = stack.last() {
        return Err(AppError::new(
            "script_compile_error",
            format!("Unclosed `{open}` starting at {open_line}:{open_col}"),
        ));
    }
    Ok(())
}

fn validate_script_syntax(script: &str) -> AppResult<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| AppError::new("script_compile_error", err.to_string()))?;

    runtime.block_on(async {
        let mut js_runtime = JsRuntime::new(RuntimeOptions::default());
        let module = resolve_url("file:///orbit-validate.js").map_err(|err| {
            AppError::new("script_compile_error", err.to_string())
        })?;
        // 只编译模块图，不 evaluate，避免执行脚本副作用
        js_runtime
            .load_main_es_module_from_code(&module, script.to_string())
            .await
            .map_err(|err| {
                AppError::new(
                    "script_compile_error",
                    format_compile_error(&err.to_string()),
                )
            })?;
        Ok(())
    })
}

fn format_compile_error(raw: &str) -> String {
    let compact = raw
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(4)
        .collect::<Vec<_>>()
        .join(" ");
    if compact.is_empty() {
        "Script syntax error".to_string()
    } else if compact.len() > 320 {
        format!("{}…", &compact[..320])
    } else {
        compact
    }
}

fn option_timeout(options: &Option<Value>, default_ms: u64) -> u64 {
    options
        .as_ref()
        .and_then(|value| value.get("timeout"))
        .and_then(Value::as_u64)
        .filter(|timeout| *timeout > 0)
        .unwrap_or(default_ms)
}

fn safe_label(label: &str) -> String {
    let safe = label
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if safe.is_empty() {
        "artifact".to_string()
    } else {
        safe
    }
}

fn write_json_file(path: &Path, data: &Value) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_vec_pretty(data)?)?;
    Ok(())
}

fn app_error_from_runtime(error: impl ToString) -> AppError {
    AppError::new("script_runtime_error", error.to_string())
}

fn js_error(error: impl ToString) -> JsErrorBox {
    JsErrorBox::generic(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_allows_valid_task_scripts() {
        assert!(validate_script_surface("await page.goto('https://example.com')").is_ok());
        assert!(validate_script_surface("const x = 1;\nlog.info(String(x));").is_ok());
        assert!(validate_script_surface("for (const url of [\"a\", \"b\"]) {\n  await page.goto(url);\n}").is_ok());
    }

    #[test]
    fn validation_rejects_syntax_and_structure_errors() {
        assert!(validate_script_surface("").is_err());
        assert!(validate_script_surface("const x = {").is_err());
        assert!(validate_script_surface("const x = 'unterminated").is_err());
        assert!(validate_script_surface("const x = ;").is_err());
    }

    #[test]
    fn warnings_detect_missing_api_usage() {
        let warnings = collect_script_warnings("const x = 1;");
        assert!(!warnings.is_empty());
        let page_warnings = collect_script_warnings("page.goto('https://example.com')");
        assert!(page_warnings.iter().any(|item| item.contains("await")));
    }

    #[test]
    fn safe_label_keeps_artifact_names_portable() {
        assert_eq!(safe_label("home-page_1"), "home-page_1");
        assert_eq!(safe_label("a/b:c"), "a_b_c");
    }

    #[test]
    fn wildcard_match_supports_url_permission_patterns() {
        assert!(wildcard_match(
            "https://example.com/*",
            "https://example.com/dashboard"
        ));
        assert!(wildcard_match("<all_urls>", "https://example.net"));
        assert!(wildcard_match(
            "https://*.example.com/path/*",
            "https://api.example.com/path/list"
        ));
        assert!(!wildcard_match(
            "https://example.com/*",
            "https://example.org/dashboard"
        ));
    }
}
