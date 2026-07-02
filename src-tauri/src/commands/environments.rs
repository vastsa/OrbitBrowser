use crate::app_state::AppState;
use crate::browser::session_registry::BrowserSession;
use crate::browser::timezone_controller::GeolocationOverride;
use crate::browser::{
    cdp_client, chrome_args, chrome_locator, port_allocator, process_manager, profile_manager,
    timezone_controller,
};
use crate::domain::environment::{
    BrowserSessionRecord, Environment, EnvironmentRuntimeStatus, RuntimeStatus,
    SaveEnvironmentInput,
};
use crate::domain::proxy::ProxyConfig;
use crate::errors::{AppError, AppResult};
use crate::storage::{environment_repo, legacy_cleanup, run_repo, settings_repo};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::State;

const AUTO_TIMEZONE_ID: &str = "auto";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BrowserLaunchMode {
    Configured,
    Headed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ProxyTestResult {
    pub ok: bool,
    pub message: String,
    pub status_code: Option<u16>,
    pub ip: Option<String>,
    pub timezone_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct ProxyProbeResult {
    status_code: Option<u16>,
    ip: Option<String>,
    timezone_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct IpWhoIsResponse {
    success: Option<bool>,
    ip: Option<String>,
    message: Option<String>,
    timezone: Option<IpWhoIsTimezone>,
}

#[derive(Debug, Deserialize)]
struct IpWhoIsTimezone {
    id: Option<String>,
}

#[tauri::command]
pub fn list_environments(state: State<'_, AppState>) -> AppResult<Vec<Environment>> {
    environment_repo::list(state.db())
}

#[tauri::command]
pub fn save_environment(
    state: State<'_, AppState>,
    input: SaveEnvironmentInput,
) -> AppResult<Environment> {
    environment_repo::save(state.db(), input)
}

#[tauri::command]
pub fn delete_environment(state: State<'_, AppState>, id: String) -> AppResult<()> {
    delete_environment_inner(&state, &id)
}

pub fn delete_environment_inner(state: &AppState, id: &str) -> AppResult<()> {
    environment_repo::get(state.db(), id)?;
    cleanup_environment_runtime_best_effort(state, id);
    let artifact_dirs = run_repo::delete_runs_for_environment(state.db(), id)?;
    legacy_cleanup::delete_ai_conversations_for_environment(state.db(), id)?;
    legacy_cleanup::delete_agent_sessions_for_environment(state.db(), id)?;
    environment_repo::hard_delete(state.db(), id)?;
    cleanup_environment_files_best_effort(state, id, artifact_dirs);
    Ok(())
}

#[tauri::command]
pub fn duplicate_environment(state: State<'_, AppState>, id: String) -> AppResult<Environment> {
    environment_repo::duplicate(state.db(), &id)
}

#[tauri::command]
pub async fn start_environment(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<EnvironmentRuntimeStatus> {
    start_environment_inner(&state, id).await
}

pub async fn start_environment_inner(
    state: &AppState,
    id: String,
) -> AppResult<EnvironmentRuntimeStatus> {
    start_environment_inner_with_options(state, id, BrowserLaunchMode::Configured).await
}

#[allow(dead_code)]
pub async fn start_environment_inner_headed(
    state: &AppState,
    id: String,
) -> AppResult<EnvironmentRuntimeStatus> {
    start_environment_inner_with_options(state, id, BrowserLaunchMode::Headed).await
}

async fn start_environment_inner_with_options(
    state: &AppState,
    id: String,
    launch_mode: BrowserLaunchMode,
) -> AppResult<EnvironmentRuntimeStatus> {
    let mut env = environment_repo::get(state.db(), &id)?;
    if launch_mode == BrowserLaunchMode::Headed {
        env.headless = false;
    }
    let profile_dir = profile_manager::ensure_profile_dir(state.data_dir(), &env)?;
    let profile_dir_text = profile_dir.to_string_lossy().to_string();

    if let Some(session) = state.sessions().get(&id) {
        if process_manager::pid_alive(session.pid)
            && process_manager::pid_command_contains(session.pid, &profile_dir_text)
        {
            if launch_mode == BrowserLaunchMode::Headed
                && process_manager::pid_command_contains(session.pid, "--headless")
            {
                tracing::info!(
                    environment_id = id,
                    pid = session.pid,
                    "Restarting registered headless environment as a headed browser"
                );
                stop_environment_inner(state, &id)?;
                if !wait_for_process_exit(session.pid).await {
                    return Err(AppError::new(
                        "profile_locked",
                        "Headless browser did not exit in time for headed restart",
                    )
                    .details(json!({ "pid": session.pid, "profileDir": profile_dir_text }))
                    .retryable(true));
                }
            } else {
                let runtime_timezone_id = resolve_runtime_timezone_id(&env).await;
                let runtime_geolocation = resolve_runtime_geolocation(&env);
                apply_runtime_overrides(
                    session.cdp_port,
                    runtime_timezone_id.clone(),
                    runtime_geolocation.clone(),
                )
                .await;
                timezone_controller::spawn(
                    session.cdp_port,
                    runtime_timezone_id,
                    runtime_geolocation,
                );
                return Ok(EnvironmentRuntimeStatus {
                    environment_id: id,
                    status: RuntimeStatus::Running,
                    pid: Some(session.pid),
                    cdp_port: Some(session.cdp_port),
                    message: Some("Environment is already running".to_string()),
                });
            }
        } else {
            state.sessions().remove(&id);
        }
    }

    for record in environment_repo::list_session_records(state.db())? {
        if record.environment_id != id {
            continue;
        }
        if process_manager::pid_alive(record.pid)
            && process_manager::pid_command_contains(record.pid, &profile_dir_text)
        {
            if launch_mode == BrowserLaunchMode::Headed
                && process_manager::pid_command_contains(record.pid, "--headless")
            {
                tracing::info!(
                    environment_id = id,
                    pid = record.pid,
                    "Restarting persisted headless environment as a headed browser"
                );
                stop_environment_inner(state, &id)?;
                if !wait_for_process_exit(record.pid).await {
                    return Err(AppError::new(
                        "profile_locked",
                        "Headless browser did not exit in time for headed restart",
                    )
                    .details(json!({ "pid": record.pid, "profileDir": profile_dir_text }))
                    .retryable(true));
                }
            } else {
                let runtime_timezone_id = resolve_runtime_timezone_id(&env).await;
                let runtime_geolocation = resolve_runtime_geolocation(&env);
                apply_runtime_overrides(
                    record.cdp_port,
                    runtime_timezone_id.clone(),
                    runtime_geolocation.clone(),
                )
                .await;
                timezone_controller::spawn(
                    record.cdp_port,
                    runtime_timezone_id,
                    runtime_geolocation,
                );
                state.sessions().upsert(BrowserSession {
                    environment_id: id.clone(),
                    pid: record.pid,
                    cdp_port: record.cdp_port,
                    websocket_url: record.websocket_url,
                    started_at: record.started_at,
                    profile_dir: profile_dir_text.clone(),
                });
                return Ok(EnvironmentRuntimeStatus {
                    environment_id: id,
                    status: RuntimeStatus::Running,
                    pid: Some(record.pid),
                    cdp_port: Some(record.cdp_port),
                    message: Some("Environment is already running".to_string()),
                });
            }
        } else {
            environment_repo::delete_session_record(state.db(), &id)?;
        }
    }

    if let Some(lock) = profile_manager::read_lock(state.data_dir(), &id)? {
        if process_manager::pid_alive(lock.pid) {
            if !process_manager::pid_command_contains(lock.pid, &profile_dir_text) {
                return Err(AppError::new(
                    "profile_locked",
                    "Profile is already used by another Chrome process",
                )
                .details(json!({ "pid": lock.pid, "profileDir": profile_dir_text }))
                .retryable(true));
            }

            if launch_mode == BrowserLaunchMode::Headed
                && process_manager::pid_command_contains(lock.pid, "--headless")
            {
                tracing::info!(
                    environment_id = id,
                    pid = lock.pid,
                    "Restarting headless environment as a headed browser"
                );
                stop_environment_inner(state, &id)?;
                if !wait_for_process_exit(lock.pid).await {
                    return Err(AppError::new(
                        "profile_locked",
                        "Headless browser did not exit in time for headed restart",
                    )
                    .details(json!({ "pid": lock.pid, "profileDir": profile_dir_text }))
                    .retryable(true));
                }
            } else {
                let runtime_timezone_id = resolve_runtime_timezone_id(&env).await;
                let runtime_geolocation = resolve_runtime_geolocation(&env);
                apply_runtime_overrides(
                    lock.cdp_port,
                    runtime_timezone_id.clone(),
                    runtime_geolocation.clone(),
                )
                .await;
                timezone_controller::spawn(lock.cdp_port, runtime_timezone_id, runtime_geolocation);
                return Ok(EnvironmentRuntimeStatus {
                    environment_id: id,
                    status: RuntimeStatus::Running,
                    pid: Some(lock.pid),
                    cdp_port: Some(lock.cdp_port),
                    message: Some("Environment is already running".to_string()),
                });
            }
        }
        profile_manager::remove_lock(state.data_dir(), &id)?;
    }

    let settings = settings_repo::get(state.db())?;
    let chrome_path = chrome_locator::resolve(
        env.chrome_path_override.as_deref(),
        settings.chrome_path.as_deref(),
    )?;
    let cdp_port = port_allocator::allocate()?;
    let runtime_timezone_id = resolve_runtime_timezone_id(&env).await;
    let runtime_geolocation = resolve_runtime_geolocation(&env);
    let launch_plan = chrome_args::build(state.data_dir(), &env, &profile_dir, cdp_port)?;
    let mut command = Command::new(&chrome_path);
    command
        .args(&launch_plan.args)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(timezone_id) = &runtime_timezone_id {
        command.env("TZ", timezone_id);
    }

    let mut child = command.spawn().map_err(|err| {
        AppError::new(
            "chrome_start_failed",
            format!("Chrome failed to start: {err}"),
        )
        .details(json!({ "chromePath": chrome_path, "args": launch_plan.args }))
        .retryable(true)
    })?;
    let pid = child.id();
    profile_manager::write_lock(state.data_dir(), &id, pid, cdp_port)?;

    let version = match cdp_client::wait_for_version(cdp_port, Duration::from_secs(15)).await {
        Ok(version) => version,
        Err(err) => {
            let _ = child.kill();
            let _ = profile_manager::remove_lock(state.data_dir(), &id);
            let _ = chrome_args::cleanup_proxy_extension(state.data_dir(), &id);
            return Err(err);
        }
    };
    apply_runtime_overrides(
        cdp_port,
        runtime_timezone_id.clone(),
        runtime_geolocation.clone(),
    )
    .await;
    timezone_controller::spawn(cdp_port, runtime_timezone_id, runtime_geolocation);

    let now = Utc::now().to_rfc3339();
    let session = BrowserSession {
        environment_id: id.clone(),
        pid,
        cdp_port,
        websocket_url: version.websocket_debugger_url.clone(),
        started_at: now.clone(),
        profile_dir: profile_dir_text.clone(),
    };
    state.sessions().upsert(session);
    environment_repo::upsert_session_record(
        state.db(),
        &BrowserSessionRecord {
            environment_id: id.clone(),
            pid,
            cdp_port,
            websocket_url: version.websocket_debugger_url,
            profile_dir: env.profile_dir,
            started_at: now.clone(),
            last_seen_at: now,
        },
    )?;

    Ok(EnvironmentRuntimeStatus {
        environment_id: id,
        status: RuntimeStatus::Running,
        pid: Some(pid),
        cdp_port: Some(cdp_port),
        message: version.browser,
    })
}

async fn wait_for_process_exit(pid: u32) -> bool {
    for _ in 0..20 {
        if !process_manager::pid_alive(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    !process_manager::pid_alive(pid)
}

#[tauri::command]
pub fn stop_environment(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<EnvironmentRuntimeStatus> {
    stop_environment_inner(&state, &id)?;
    Ok(EnvironmentRuntimeStatus {
        environment_id: id,
        status: RuntimeStatus::Stopped,
        pid: None,
        cdp_port: None,
        message: Some("Stopped".to_string()),
    })
}

#[tauri::command]
pub async fn restart_environment(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<EnvironmentRuntimeStatus> {
    stop_environment_inner(&state, &id)?;
    start_environment_inner(&state, id).await
}

#[tauri::command]
pub async fn get_environment_statuses(
    state: State<'_, AppState>,
) -> AppResult<Vec<EnvironmentRuntimeStatus>> {
    let environments = environment_repo::list(state.db())?;
    let records = environment_repo::list_session_records(state.db())?;
    let mut statuses = Vec::with_capacity(environments.len());

    for env in environments {
        let session = state.sessions().get(&env.id);
        let record = records
            .iter()
            .find(|record| record.environment_id == env.id);
        let lock = profile_manager::read_lock(state.data_dir(), &env.id)?;

        let status = if let Some(session) = session {
            status_from_pid_and_cdp(&env.id, session.pid, session.cdp_port).await
        } else if let Some(record) = record {
            status_from_pid_and_cdp(&env.id, record.pid, record.cdp_port).await
        } else if let Some(lock) = lock {
            if process_manager::pid_alive(lock.pid) {
                EnvironmentRuntimeStatus {
                    environment_id: env.id.clone(),
                    status: RuntimeStatus::Unknown,
                    pid: Some(lock.pid),
                    cdp_port: Some(lock.cdp_port),
                    message: Some("Found a profile lock without a session record".to_string()),
                }
            } else {
                EnvironmentRuntimeStatus {
                    environment_id: env.id.clone(),
                    status: RuntimeStatus::Crashed,
                    pid: Some(lock.pid),
                    cdp_port: Some(lock.cdp_port),
                    message: Some("Found a stale profile lock".to_string()),
                }
            }
        } else {
            EnvironmentRuntimeStatus {
                environment_id: env.id.clone(),
                status: RuntimeStatus::Stopped,
                pid: None,
                cdp_port: None,
                message: None,
            }
        };

        statuses.push(status);
    }

    Ok(statuses)
}

#[tauri::command]
pub fn validate_environment(input: SaveEnvironmentInput) -> AppResult<()> {
    if input.name.trim().is_empty() {
        return Err(AppError::new(
            "validation_error",
            "Environment name is required",
        ));
    }
    if input.viewport_width < 320 || input.viewport_height < 240 {
        return Err(AppError::new(
            "validation_error",
            "Viewport size cannot be smaller than 320x240",
        ));
    }
    validate_geolocation(input.geolocation_latitude, input.geolocation_longitude)?;
    if input.proxy_config.kind != crate::domain::proxy::ProxyKind::None
        && (input
            .proxy_config
            .host
            .as_deref()
            .unwrap_or("")
            .trim()
            .is_empty()
            || input.proxy_config.port.is_none())
    {
        return Err(AppError::new(
            "proxy_invalid",
            "Proxy host and port are required",
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn test_environment_proxy(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<ProxyTestResult> {
    let env = environment_repo::get(state.db(), &id)?;
    if env.proxy_config.chrome_server().is_none() {
        return Ok(ProxyTestResult {
            ok: true,
            message: "No proxy configured".to_string(),
            status_code: None,
            ip: None,
            timezone_id: env.timezone_id,
        });
    }

    let probe = probe_proxy(&env.proxy_config, Duration::from_secs(8)).await?;
    let timezone_text = probe
        .timezone_id
        .as_deref()
        .map(|timezone_id| format!(" ({timezone_id})"))
        .unwrap_or_default();

    Ok(ProxyTestResult {
        ok: true,
        message: if let Some(ip) = probe.ip.as_deref() {
            format!("Proxy reachable: {ip}{timezone_text}")
        } else {
            format!("Proxy reachable{timezone_text}")
        },
        status_code: probe.status_code,
        ip: probe.ip,
        timezone_id: probe.timezone_id,
    })
}

async fn resolve_runtime_timezone_id(env: &Environment) -> Option<String> {
    let configured_timezone_id = normalize_optional_text(env.timezone_id.clone());
    if !is_auto_timezone(configured_timezone_id.as_deref()) {
        return configured_timezone_id;
    }

    match probe_ip_timezone(&env.proxy_config, Duration::from_secs(4)).await {
        Ok(probe) => probe.timezone_id,
        Err(err) => {
            tracing::warn!(
                environment_id = env.id,
                error = %err,
                "Failed to detect auto timezone"
            );
            None
        }
    }
}

fn resolve_runtime_geolocation(env: &Environment) -> Option<GeolocationOverride> {
    Some(GeolocationOverride {
        latitude: env.geolocation_latitude?,
        longitude: env.geolocation_longitude?,
        accuracy: 20.0,
    })
}

async fn probe_proxy(proxy_config: &ProxyConfig, timeout: Duration) -> AppResult<ProxyProbeResult> {
    let Some(server) = proxy_config.chrome_server() else {
        return Ok(ProxyProbeResult::default());
    };
    probe_ip_timezone_with_proxy(proxy_config, &server, timeout).await
}

async fn probe_ip_timezone(
    proxy_config: &ProxyConfig,
    timeout: Duration,
) -> AppResult<ProxyProbeResult> {
    if let Some(server) = proxy_config.chrome_server() {
        return probe_ip_timezone_with_proxy(proxy_config, &server, timeout).await;
    }

    let client = reqwest::Client::builder().timeout(timeout).build()?;
    fetch_ip_timezone(client).await
}

async fn probe_ip_timezone_with_proxy(
    proxy_config: &ProxyConfig,
    server: &str,
    timeout: Duration,
) -> AppResult<ProxyProbeResult> {
    let mut proxy = reqwest::Proxy::all(server)
        .map_err(|err| AppError::new("proxy_invalid", format!("Invalid proxy format: {err}")))?;
    if let Some(username) = proxy_config.username.as_deref() {
        proxy = proxy.basic_auth(username, proxy_config.password.as_deref().unwrap_or(""));
    }
    let client = reqwest::Client::builder()
        .proxy(proxy)
        .timeout(timeout)
        .build()?;
    fetch_ip_timezone(client).await
}

async fn fetch_ip_timezone(client: reqwest::Client) -> AppResult<ProxyProbeResult> {
    let response = client.get("http://ipwho.is/").send().await.map_err(|err| {
        AppError::new(
            "proxy_connect_failed",
            format!("IP timezone lookup failed: {err}"),
        )
    })?;
    let status = response.status();
    let status_code = Some(status.as_u16());
    if !status.is_success() {
        return Err(AppError::new(
            "proxy_connect_failed",
            format!("Proxy returned HTTP {status}"),
        ));
    }

    let body = response.json::<IpWhoIsResponse>().await?;
    if body.success == Some(false) {
        return Err(AppError::new(
            "proxy_connect_failed",
            body.message
                .unwrap_or_else(|| "Proxy IP metadata lookup failed".to_string()),
        ));
    }

    Ok(ProxyProbeResult {
        status_code,
        ip: normalize_optional_text(body.ip),
        timezone_id: body
            .timezone
            .and_then(|timezone| normalize_optional_text(timezone.id)),
    })
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn is_auto_timezone(timezone_id: Option<&str>) -> bool {
    timezone_id.is_none_or(|value| value.eq_ignore_ascii_case(AUTO_TIMEZONE_ID))
}

async fn apply_runtime_overrides(
    cdp_port: u16,
    timezone_id: Option<String>,
    geolocation: Option<GeolocationOverride>,
) {
    if let Err(err) = timezone_controller::apply_existing(cdp_port, timezone_id, geolocation).await
    {
        tracing::warn!(
            cdp_port,
            error = %err,
            "Failed to apply initial runtime overrides"
        );
    }
}

fn validate_geolocation(latitude: Option<f64>, longitude: Option<f64>) -> AppResult<()> {
    match (latitude, longitude) {
        (Some(latitude), Some(longitude)) => {
            if !(-90.0..=90.0).contains(&latitude) {
                return Err(AppError::new(
                    "validation_error",
                    "Latitude must be between -90 and 90",
                ));
            }
            if !(-180.0..=180.0).contains(&longitude) {
                return Err(AppError::new(
                    "validation_error",
                    "Longitude must be between -180 and 180",
                ));
            }
        }
        (None, None) => {}
        _ => {
            return Err(AppError::new(
                "validation_error",
                "Latitude and longitude must be provided together",
            ));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn open_environment_profile_dir(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let env = environment_repo::get(state.db(), &id)?;
    let path = profile_manager::profile_dir(state.data_dir(), &env);
    std::fs::create_dir_all(&path)?;
    super::open_path(&path)
}

pub fn stop_environment_inner(state: &AppState, id: &str) -> AppResult<()> {
    let session_pid = state.sessions().remove(id).map(|session| session.pid);
    let record_pid = environment_repo::list_session_records(state.db())?
        .into_iter()
        .find(|record| record.environment_id == id)
        .map(|record| record.pid);
    let lock_pid = profile_manager::read_lock(state.data_dir(), id)?.map(|lock| lock.pid);
    let pid = session_pid.or(record_pid).or(lock_pid);

    if let Some(pid) = pid {
        if process_manager::pid_alive(pid) {
            process_manager::kill_pid(pid);
        }
    }
    environment_repo::delete_session_record(state.db(), id)?;
    profile_manager::remove_lock(state.data_dir(), id)?;
    chrome_args::cleanup_proxy_extension(state.data_dir(), id)?;
    Ok(())
}

fn cleanup_environment_runtime_best_effort(state: &AppState, id: &str) {
    let session_pid = state.sessions().remove(id).map(|session| session.pid);
    let record_pid = match environment_repo::list_session_records(state.db()) {
        Ok(records) => records
            .into_iter()
            .find(|record| record.environment_id == id)
            .map(|record| record.pid),
        Err(err) => {
            tracing::warn!(environment_id = id, error = %err, "Failed to read environment session record");
            None
        }
    };
    let lock_pid = match profile_manager::read_lock(state.data_dir(), id) {
        Ok(lock) => lock.map(|lock| lock.pid),
        Err(err) => {
            tracing::warn!(environment_id = id, error = %err, "Failed to read environment profile lock");
            None
        }
    };

    if let Some(pid) = session_pid.or(record_pid).or(lock_pid) {
        if process_manager::pid_alive(pid) && !process_manager::kill_pid(pid) {
            tracing::warn!(
                environment_id = id,
                pid,
                "Failed to stop environment process"
            );
        }
    }
    if let Err(err) = environment_repo::delete_session_record(state.db(), id) {
        tracing::warn!(environment_id = id, error = %err, "Failed to delete environment session record");
    }
    if let Err(err) = profile_manager::remove_lock(state.data_dir(), id) {
        tracing::warn!(environment_id = id, error = %err, "Failed to delete environment profile lock");
    }
    if let Err(err) = chrome_args::cleanup_proxy_extension(state.data_dir(), id) {
        tracing::warn!(environment_id = id, error = %err, "Failed to clean environment proxy extension");
    }
}

fn cleanup_environment_files_best_effort(state: &AppState, id: &str, artifact_dirs: Vec<String>) {
    for relative_dir in artifact_dirs {
        let path = state.data_dir().join(relative_dir);
        if path.exists() {
            let _ = std::fs::remove_dir_all(path);
        }
    }
    let profile_dir = profile_manager::environment_dir(state.data_dir(), id);
    if profile_dir.exists() {
        let _ = std::fs::remove_dir_all(profile_dir);
    }
}

async fn status_from_pid_and_cdp(
    environment_id: &str,
    pid: u32,
    cdp_port: u16,
) -> EnvironmentRuntimeStatus {
    if !process_manager::pid_alive(pid) {
        return EnvironmentRuntimeStatus {
            environment_id: environment_id.to_string(),
            status: RuntimeStatus::Crashed,
            pid: Some(pid),
            cdp_port: Some(cdp_port),
            message: Some("Process does not exist".to_string()),
        };
    }

    if cdp_client::ping(cdp_port).await {
        EnvironmentRuntimeStatus {
            environment_id: environment_id.to_string(),
            status: RuntimeStatus::Running,
            pid: Some(pid),
            cdp_port: Some(cdp_port),
            message: None,
        }
    } else {
        EnvironmentRuntimeStatus {
            environment_id: environment_id.to_string(),
            status: RuntimeStatus::Unknown,
            pid: Some(pid),
            cdp_port: Some(cdp_port),
            message: Some("Process exists, but CDP is not available yet".to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::environment::{BrowserKind, EnvironmentMode, SaveEnvironmentInput};
    use crate::domain::proxy::ProxyConfig;

    fn test_data_dir() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("orbit-delete-env-test-{}", uuid::Uuid::new_v4()))
    }

    fn test_environment_input(id: &str) -> SaveEnvironmentInput {
        SaveEnvironmentInput {
            id: Some(id.to_string()),
            name: "Delete Test Environment".to_string(),
            group_id: None,
            tags: Vec::new(),
            notes: None,
            browser_kind: BrowserKind::Chrome,
            chrome_path_override: None,
            proxy_config: ProxyConfig::default(),
            locale: "en-US".to_string(),
            timezone_id: Some("UTC".to_string()),
            geolocation_latitude: None,
            geolocation_longitude: None,
            user_agent: None,
            platform: None,
            web_rtc_protection: true,
            viewport_width: 1280,
            viewport_height: 800,
            device_scale_factor: 1.0,
            environment_mode: EnvironmentMode::Standard,
            seed: None,
            headless: false,
            start_url: Some("about:blank".to_string()),
        }
    }

    #[test]
    fn delete_environment_ignores_broken_profile_lock() {
        let root = test_data_dir();
        let state = AppState::initialize(root.clone()).unwrap();
        let environment_id = "env_delete_broken_lock";
        environment_repo::save(state.db(), test_environment_input(environment_id)).unwrap();

        let lock_dir = profile_manager::environment_dir(state.data_dir(), environment_id);
        std::fs::create_dir_all(&lock_dir).unwrap();
        std::fs::write(
            profile_manager::lock_path(state.data_dir(), environment_id),
            "{ broken json",
        )
        .unwrap();

        delete_environment_inner(&state, environment_id).unwrap();

        let error = environment_repo::get(state.db(), environment_id).unwrap_err();
        assert_eq!(error.code, "environment_not_found");
        assert!(!profile_manager::lock_path(state.data_dir(), environment_id).exists());

        std::fs::remove_dir_all(root).unwrap();
    }
}
