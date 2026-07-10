use crate::app_state::AppState;
use crate::browser::session_registry::BrowserSession;
use crate::browser::timezone_controller::{BrowserRuntimeOverrides, GeolocationOverride};
use crate::browser::{
    camoufox_locator, camoufox_runtime, cdp_client, chrome_args, chrome_locator, port_allocator,
    process_manager, profile_manager, runtime_page, timezone_controller,
};
use crate::domain::environment::{
    BrowserKind, BrowserSessionRecord, Environment, EnvironmentRuntimeStatus, RuntimeStatus,
    SaveEnvironmentInput,
};
use crate::domain::proxy::ProxyConfig;
use crate::errors::{AppError, AppResult};
use crate::storage::{environment_repo, legacy_cleanup, run_repo, settings_repo};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs::OpenOptions;
use std::path::Path;
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
    country_code: Option<String>,
    timezone_id: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
}

#[derive(Debug, Clone)]
struct RuntimeFingerprint {
    locale: String,
    locale_override: Option<String>,
    accept_languages: Option<String>,
    timezone_id: Option<String>,
    geolocation: Option<GeolocationOverride>,
}

#[derive(Debug, Clone)]
struct LocaleProfile {
    locale: &'static str,
    accept_languages: &'static str,
}

#[derive(Debug, Deserialize)]
struct IpWhoIsResponse {
    success: Option<bool>,
    ip: Option<String>,
    country_code: Option<String>,
    message: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
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
        if runtime_pid_matches(&env, session.pid, &profile_dir_text) {
            let restart_headed = launch_mode == BrowserLaunchMode::Headed
                && process_manager::pid_command_contains(session.pid, "--headless");
            let restart_legacy_chrome =
                chrome_process_uses_legacy_fingerprint_flags(&env, session.pid);
            if restart_headed || restart_legacy_chrome {
                tracing::info!(
                    environment_id = id,
                    pid = session.pid,
                    restart_headed,
                    restart_legacy_chrome,
                    "Restarting registered environment with incompatible launch settings"
                );
                stop_environment_inner(state, &id)?;
                if !wait_for_process_exit(session.pid).await {
                    return Err(AppError::new(
                        "profile_locked",
                        "Browser did not exit in time for restart",
                    )
                    .details(json!({ "pid": session.pid, "profileDir": profile_dir_text }))
                    .retryable(true));
                }
            } else {
                if !matches!(env.browser_kind, BrowserKind::Camoufox) {
                    let runtime_fingerprint = resolve_runtime_fingerprint(&env).await;
                    apply_and_watch_runtime(session.cdp_port, runtime_fingerprint).await;
                }
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
        if runtime_pid_matches(&env, record.pid, &profile_dir_text) {
            let restart_headed = launch_mode == BrowserLaunchMode::Headed
                && process_manager::pid_command_contains(record.pid, "--headless");
            let restart_legacy_chrome =
                chrome_process_uses_legacy_fingerprint_flags(&env, record.pid);
            if restart_headed || restart_legacy_chrome {
                tracing::info!(
                    environment_id = id,
                    pid = record.pid,
                    restart_headed,
                    restart_legacy_chrome,
                    "Restarting persisted environment with incompatible launch settings"
                );
                stop_environment_inner(state, &id)?;
                if !wait_for_process_exit(record.pid).await {
                    return Err(AppError::new(
                        "profile_locked",
                        "Browser did not exit in time for restart",
                    )
                    .details(json!({ "pid": record.pid, "profileDir": profile_dir_text }))
                    .retryable(true));
                }
            } else {
                if !matches!(env.browser_kind, BrowserKind::Camoufox) {
                    let runtime_fingerprint = resolve_runtime_fingerprint(&env).await;
                    apply_and_watch_runtime(record.cdp_port, runtime_fingerprint).await;
                }
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
            if !runtime_pid_matches(&env, lock.pid, &profile_dir_text) {
                return Err(AppError::new(
                    "profile_locked",
                    "Profile is already used by another browser process",
                )
                .details(json!({ "pid": lock.pid, "profileDir": profile_dir_text }))
                .retryable(true));
            }

            let restart_headed = launch_mode == BrowserLaunchMode::Headed
                && process_manager::pid_command_contains(lock.pid, "--headless");
            let restart_legacy_chrome =
                chrome_process_uses_legacy_fingerprint_flags(&env, lock.pid);
            if restart_headed || restart_legacy_chrome {
                tracing::info!(
                    environment_id = id,
                    pid = lock.pid,
                    restart_headed,
                    restart_legacy_chrome,
                    "Restarting locked environment with incompatible launch settings"
                );
                stop_environment_inner(state, &id)?;
                if !wait_for_process_exit(lock.pid).await {
                    return Err(AppError::new(
                        "profile_locked",
                        "Browser did not exit in time for restart",
                    )
                    .details(json!({ "pid": lock.pid, "profileDir": profile_dir_text }))
                    .retryable(true));
                }
            } else {
                if !matches!(env.browser_kind, BrowserKind::Camoufox) {
                    let runtime_fingerprint = resolve_runtime_fingerprint(&env).await;
                    apply_and_watch_runtime(lock.cdp_port, runtime_fingerprint).await;
                }
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
    if matches!(env.browser_kind, BrowserKind::Camoufox) {
        return start_camoufox_environment(
            state,
            env,
            profile_dir,
            profile_dir_text,
            settings.camoufox_python_path.as_deref(),
        )
        .await;
    }
    let chrome_path = chrome_locator::resolve(
        env.chrome_path_override.as_deref(),
        settings.chrome_path.as_deref(),
    )?;
    let cdp_port = port_allocator::allocate()?;
    let runtime_fingerprint = resolve_runtime_fingerprint(&env).await;
    let launch_plan = chrome_args::build(
        state.data_dir(),
        &env,
        &profile_dir,
        cdp_port,
        runtime_fingerprint.accept_languages.as_deref(),
    )?;
    let mut command = Command::new(&chrome_path);
    command
        .args(&launch_plan.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_browser_process(&mut command);
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
            let _ = child.wait();
            let _ = profile_manager::remove_lock(state.data_dir(), &id);
            let _ = chrome_args::cleanup_proxy_extension(state.data_dir(), &id);
            return Err(err);
        }
    };
    reap_browser_child_on_exit(child);
    let has_geolocation_override = runtime_fingerprint.geolocation.is_some();
    apply_and_watch_runtime(cdp_port, runtime_fingerprint).await;
    navigate_start_url_after_overrides(
        cdp_port,
        env.start_url.as_deref(),
        has_geolocation_override,
    )
    .await;

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

fn runtime_pid_matches(env: &Environment, pid: u32, profile_dir_text: &str) -> bool {
    if !process_manager::pid_alive(pid) {
        return false;
    }
    if matches!(env.browser_kind, BrowserKind::Camoufox) {
        return process_manager::pid_command_contains(pid, "orbit_camoufox_worker.py")
            || process_manager::pid_command_contains(pid, &env.id);
    }
    process_manager::pid_command_contains(pid, profile_dir_text)
}

fn chrome_process_uses_legacy_fingerprint_flags(env: &Environment, pid: u32) -> bool {
    if !matches!(env.browser_kind, BrowserKind::Chrome) {
        return false;
    }
    [
        "--lang=",
        "--user-agent=",
        "--window-size=",
        "--force-webrtc-ip-handling-policy=",
    ]
    .iter()
    .any(|flag| process_manager::pid_command_contains(pid, flag))
}

async fn start_camoufox_environment(
    state: &AppState,
    env: Environment,
    profile_dir: std::path::PathBuf,
    profile_dir_text: String,
    settings_python_path: Option<&str>,
) -> AppResult<EnvironmentRuntimeStatus> {
    let python_path = camoufox_locator::resolve(camoufox_python_override(
        env.chrome_path_override.as_deref(),
        settings_python_path,
    ))?;
    let runtime_fingerprint = resolve_runtime_fingerprint(&env).await;
    let control_port = port_allocator::allocate()?;
    let launch_plan = camoufox_runtime::build(
        state.data_dir(),
        &env,
        &profile_dir,
        control_port,
        &runtime_fingerprint.locale,
    )?;

    let mut command = Command::new(&python_path);
    let stdout_log = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&launch_plan.log_path)?;
    let stderr_log = stdout_log.try_clone()?;
    command
        .arg(&launch_plan.worker_script_path)
        .arg(&launch_plan.profile_json_path)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_log))
        .stderr(Stdio::from(stderr_log));
    configure_browser_process(&mut command);
    if let Some(timezone_id) = &runtime_fingerprint.timezone_id {
        command.env("TZ", timezone_id);
    }

    let mut child = command.spawn().map_err(|err| {
        AppError::new(
            "camoufox_start_failed",
            format!("Camoufox failed to start: {err}"),
        )
        .details(json!({
            "pythonPath": python_path,
            "workerScript": launch_plan.worker_script_path,
            "profileJson": launch_plan.profile_json_path,
            "logPath": launch_plan.log_path,
        }))
        .retryable(true)
    })?;
    let pid = child.id();
    wait_for_camoufox_ready(&mut child, control_port, &launch_plan.log_path).await?;
    profile_manager::write_lock(state.data_dir(), &env.id, pid, control_port)?;
    reap_browser_child_on_exit(child);

    let now = Utc::now().to_rfc3339();
    let session = BrowserSession {
        environment_id: env.id.clone(),
        pid,
        cdp_port: control_port,
        websocket_url: Some(format!("camoufox://127.0.0.1:{control_port}")),
        started_at: now.clone(),
        profile_dir: profile_dir_text,
    };
    state.sessions().upsert(session);
    environment_repo::upsert_session_record(
        state.db(),
        &BrowserSessionRecord {
            environment_id: env.id.clone(),
            pid,
            cdp_port: control_port,
            websocket_url: Some(format!("camoufox://127.0.0.1:{control_port}")),
            profile_dir: env.profile_dir,
            started_at: now.clone(),
            last_seen_at: now,
        },
    )?;

    Ok(EnvironmentRuntimeStatus {
        environment_id: env.id,
        status: RuntimeStatus::Running,
        pid: Some(pid),
        cdp_port: Some(control_port),
        message: Some("Camoufox runtime started".to_string()),
    })
}

fn camoufox_python_override<'a>(
    environment_path: Option<&'a str>,
    settings_path: Option<&'a str>,
) -> Option<&'a str> {
    environment_path
        .filter(|path| !path.trim().is_empty())
        .or_else(|| settings_path.filter(|path| !path.trim().is_empty()))
}

async fn wait_for_camoufox_ready(
    child: &mut std::process::Child,
    control_port: u16,
    log_path: &Path,
) -> AppResult<()> {
    for _ in 0..90 {
        if runtime_page::camoufox_ping(control_port).await {
            return Ok(());
        }
        if let Some(status) = child.try_wait()? {
            return Err(AppError::new(
                "camoufox_start_failed",
                format!("Camoufox worker exited before it was ready: {status}"),
            )
            .details(json!({
                "controlPort": control_port,
                "logPath": log_path,
                "logTail": read_log_tail(log_path),
            }))
            .retryable(true));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    Err(AppError::new(
        "camoufox_start_failed",
        "Timed out waiting for Camoufox to become ready",
    )
    .details(json!({
        "controlPort": control_port,
        "logPath": log_path,
        "logTail": read_log_tail(log_path),
    }))
    .retryable(true))
}

fn read_log_tail(path: &Path) -> String {
    let Ok(text) = std::fs::read_to_string(path) else {
        return String::new();
    };
    let max_chars = 8000;
    let mut chars = text.chars().rev().take(max_chars).collect::<Vec<_>>();
    chars.reverse();
    chars.into_iter().collect()
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
            status_from_pid_and_runtime(&env, session.pid, session.cdp_port).await
        } else if let Some(record) = record {
            status_from_pid_and_runtime(&env, record.pid, record.cdp_port).await
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

async fn resolve_runtime_fingerprint(env: &Environment) -> RuntimeFingerprint {
    let configured_timezone_id = normalize_optional_text(env.timezone_id.clone());
    let configured_locale = normalize_optional_text(Some(env.locale.clone()));
    let needs_ip_probe = matches!(env.browser_kind, BrowserKind::Chrome)
        || is_auto_timezone(configured_timezone_id.as_deref())
        || (matches!(env.browser_kind, BrowserKind::Camoufox)
            && is_auto_text(configured_locale.as_deref()));
    let probe = if needs_ip_probe {
        match probe_ip_timezone(&env.proxy_config, Duration::from_secs(4)).await {
            Ok(probe) => Some(probe),
            Err(err) => {
                tracing::warn!(
                    environment_id = env.id,
                    error = %err,
                    "Failed to detect IP-based runtime fingerprint"
                );
                None
            }
        }
    } else {
        None
    };

    let timezone_id = if matches!(env.browser_kind, BrowserKind::Chrome)
        || is_auto_timezone(configured_timezone_id.as_deref())
    {
        probe.as_ref().and_then(|probe| probe.timezone_id.clone())
    } else {
        configured_timezone_id
    };
    let locale_profile = locale_profile_for(
        probe
            .as_ref()
            .and_then(|probe| probe.country_code.as_deref()),
        timezone_id.as_deref(),
    );
    let locale = if matches!(env.browser_kind, BrowserKind::Chrome)
        || is_auto_text(configured_locale.as_deref())
    {
        locale_profile.locale.to_string()
    } else {
        configured_locale.unwrap_or_else(|| locale_profile.locale.to_string())
    };
    let geolocation = resolve_runtime_geolocation(env, probe.as_ref());
    let chrome_probe_succeeded = matches!(env.browser_kind, BrowserKind::Chrome) && probe.is_some();

    RuntimeFingerprint {
        locale: locale.clone(),
        locale_override: chrome_probe_succeeded.then_some(locale),
        accept_languages: chrome_probe_succeeded
            .then(|| locale_profile.accept_languages.to_string()),
        timezone_id,
        geolocation,
    }
}

fn resolve_runtime_geolocation(
    env: &Environment,
    probe: Option<&ProxyProbeResult>,
) -> Option<GeolocationOverride> {
    if let (Some(latitude), Some(longitude)) = (env.geolocation_latitude, env.geolocation_longitude)
    {
        return Some(GeolocationOverride {
            latitude,
            longitude,
            accuracy: 20.0,
        });
    }

    Some(GeolocationOverride {
        latitude: probe?.latitude?,
        longitude: probe?.longitude?,
        // IP 地理位置是城市级估算，避免伪装成不合理的 GPS 高精度。
        accuracy: 50_000.0,
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
        country_code: normalize_optional_text(body.country_code).map(|value| value.to_uppercase()),
        timezone_id: body
            .timezone
            .and_then(|timezone| normalize_optional_text(timezone.id)),
        latitude: body.latitude,
        longitude: body.longitude,
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

fn is_auto_text(value: Option<&str>) -> bool {
    value.is_none_or(|value| value.eq_ignore_ascii_case(AUTO_TIMEZONE_ID))
}

fn locale_profile_for(country_code: Option<&str>, timezone_id: Option<&str>) -> LocaleProfile {
    match country_code.unwrap_or_default() {
        "CN" => LocaleProfile {
            locale: "zh-CN",
            accept_languages: "zh-CN,zh",
        },
        "HK" => LocaleProfile {
            locale: "zh-HK",
            accept_languages: "zh-HK,zh",
        },
        "MO" => LocaleProfile {
            locale: "zh-MO",
            accept_languages: "zh-MO,zh",
        },
        "TW" => LocaleProfile {
            locale: "zh-TW",
            accept_languages: "zh-TW,zh",
        },
        "JP" => LocaleProfile {
            locale: "ja-JP",
            accept_languages: "ja-JP,ja",
        },
        "KR" => LocaleProfile {
            locale: "ko-KR",
            accept_languages: "ko-KR,ko",
        },
        "GB" => LocaleProfile {
            locale: "en-GB",
            accept_languages: "en-GB,en",
        },
        "CA" => LocaleProfile {
            locale: "en-CA",
            accept_languages: "en-CA,en",
        },
        "AU" => LocaleProfile {
            locale: "en-AU",
            accept_languages: "en-AU,en",
        },
        "NZ" => LocaleProfile {
            locale: "en-NZ",
            accept_languages: "en-NZ,en",
        },
        "DE" => LocaleProfile {
            locale: "de-DE",
            accept_languages: "de-DE,de,en",
        },
        "AT" => LocaleProfile {
            locale: "de-AT",
            accept_languages: "de-AT,de,en",
        },
        "CH" => LocaleProfile {
            locale: "de-CH",
            accept_languages: "de-CH,de,en",
        },
        "FR" => LocaleProfile {
            locale: "fr-FR",
            accept_languages: "fr-FR,fr,en",
        },
        "ES" => LocaleProfile {
            locale: "es-ES",
            accept_languages: "es-ES,es,en",
        },
        "MX" => LocaleProfile {
            locale: "es-MX",
            accept_languages: "es-MX,es,en",
        },
        "IT" => LocaleProfile {
            locale: "it-IT",
            accept_languages: "it-IT,it,en",
        },
        "BR" => LocaleProfile {
            locale: "pt-BR",
            accept_languages: "pt-BR,pt,en",
        },
        "PT" => LocaleProfile {
            locale: "pt-PT",
            accept_languages: "pt-PT,pt,en",
        },
        "RU" => LocaleProfile {
            locale: "ru-RU",
            accept_languages: "ru-RU,ru,en",
        },
        "NL" => LocaleProfile {
            locale: "nl-NL",
            accept_languages: "nl-NL,nl,en",
        },
        "PL" => LocaleProfile {
            locale: "pl-PL",
            accept_languages: "pl-PL,pl,en",
        },
        "TR" => LocaleProfile {
            locale: "tr-TR",
            accept_languages: "tr-TR,tr,en",
        },
        "IN" => LocaleProfile {
            locale: "en-IN",
            accept_languages: "en-IN,en",
        },
        "SG" => LocaleProfile {
            locale: "en-SG",
            accept_languages: "en-SG,en",
        },
        "US" => LocaleProfile {
            locale: "en-US",
            accept_languages: "en-US,en",
        },
        _ => locale_profile_for_timezone(timezone_id),
    }
}

fn locale_profile_for_timezone(timezone_id: Option<&str>) -> LocaleProfile {
    let timezone_id = timezone_id.unwrap_or_default();
    if timezone_id.starts_with("Asia/Shanghai")
        || timezone_id.starts_with("Asia/Urumqi")
        || timezone_id.starts_with("Asia/Chongqing")
        || timezone_id.starts_with("Asia/Harbin")
    {
        return LocaleProfile {
            locale: "zh-CN",
            accept_languages: "zh-CN,zh",
        };
    }
    if timezone_id.starts_with("Asia/Tokyo") {
        return LocaleProfile {
            locale: "ja-JP",
            accept_languages: "ja-JP,ja",
        };
    }
    if timezone_id.starts_with("Asia/Seoul") {
        return LocaleProfile {
            locale: "ko-KR",
            accept_languages: "ko-KR,ko",
        };
    }
    if timezone_id.starts_with("Europe/London") {
        return LocaleProfile {
            locale: "en-GB",
            accept_languages: "en-GB,en",
        };
    }
    LocaleProfile {
        locale: "en-US",
        accept_languages: "en-US,en",
    }
}

async fn apply_and_watch_runtime(cdp_port: u16, fingerprint: RuntimeFingerprint) {
    let overrides = BrowserRuntimeOverrides::new(
        fingerprint.timezone_id,
        fingerprint.geolocation,
        fingerprint.locale_override,
    );
    if let Err(err) = timezone_controller::apply_and_watch(cdp_port, overrides).await {
        tracing::warn!(
            cdp_port,
            error = %err,
            "Failed to apply initial runtime overrides"
        );
    }
}

fn reap_browser_child_on_exit(mut child: std::process::Child) {
    std::thread::spawn(move || {
        let _ = child.wait();
    });
}

#[cfg(target_os = "windows")]
fn configure_browser_process(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn configure_browser_process(_command: &mut Command) {}

async fn navigate_start_url_after_overrides(
    cdp_port: u16,
    start_url: Option<&str>,
    grant_geolocation: bool,
) {
    let Some(start_url) = start_url
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("about:blank"))
    else {
        return;
    };

    if grant_geolocation {
        if let Err(err) =
            timezone_controller::grant_geolocation_permission(cdp_port, start_url).await
        {
            tracing::warn!(
                cdp_port,
                start_url,
                error = %err,
                "Failed to grant geolocation permission before start URL navigation"
            );
        }
    }

    match cdp_client::CdpPage::connect(cdp_port, None).await {
        Ok(mut page) => {
            if let Err(err) = page.navigate_without_wait(start_url).await {
                tracing::warn!(
                    cdp_port,
                    start_url,
                    error = %err,
                    "Failed to navigate start URL after runtime overrides"
                );
            }
        }
        Err(err) => {
            tracing::warn!(
                cdp_port,
                start_url,
                error = %err,
                "Failed to connect page for delayed start URL navigation"
            );
        }
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
    let session = state.sessions().remove(id);
    let record = environment_repo::list_session_records(state.db())?
        .into_iter()
        .find(|record| record.environment_id == id);
    let lock = profile_manager::read_lock(state.data_dir(), id)?;
    let cdp_port = session
        .as_ref()
        .map(|session| session.cdp_port)
        .or_else(|| record.as_ref().map(|record| record.cdp_port))
        .or_else(|| lock.as_ref().map(|lock| lock.cdp_port));
    let pid = session
        .map(|session| session.pid)
        .or_else(|| record.map(|record| record.pid))
        .or_else(|| lock.map(|lock| lock.pid));

    if let Some(cdp_port) = cdp_port {
        timezone_controller::stop_watcher(cdp_port);
    }

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
    let session = state.sessions().remove(id);
    let record = match environment_repo::list_session_records(state.db()) {
        Ok(records) => records
            .into_iter()
            .find(|record| record.environment_id == id),
        Err(err) => {
            tracing::warn!(environment_id = id, error = %err, "Failed to read environment session record");
            None
        }
    };
    let lock = match profile_manager::read_lock(state.data_dir(), id) {
        Ok(lock) => lock,
        Err(err) => {
            tracing::warn!(environment_id = id, error = %err, "Failed to read environment profile lock");
            None
        }
    };

    let cdp_port = session
        .as_ref()
        .map(|session| session.cdp_port)
        .or_else(|| record.as_ref().map(|record| record.cdp_port))
        .or_else(|| lock.as_ref().map(|lock| lock.cdp_port));
    let pid = session
        .map(|session| session.pid)
        .or_else(|| record.map(|record| record.pid))
        .or_else(|| lock.map(|lock| lock.pid));

    if let Some(cdp_port) = cdp_port {
        timezone_controller::stop_watcher(cdp_port);
    }

    if let Some(pid) = pid {
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

async fn status_from_pid_and_runtime(
    env: &Environment,
    pid: u32,
    runtime_port: u16,
) -> EnvironmentRuntimeStatus {
    if !process_manager::pid_alive(pid) {
        return EnvironmentRuntimeStatus {
            environment_id: env.id.clone(),
            status: RuntimeStatus::Crashed,
            pid: Some(pid),
            cdp_port: Some(runtime_port),
            message: Some("Process does not exist".to_string()),
        };
    }

    if matches!(env.browser_kind, BrowserKind::Camoufox) {
        if runtime_page::camoufox_ping(runtime_port).await {
            return EnvironmentRuntimeStatus {
                environment_id: env.id.clone(),
                status: RuntimeStatus::Running,
                pid: Some(pid),
                cdp_port: Some(runtime_port),
                message: Some("Camoufox control bridge is available".to_string()),
            };
        }
        return EnvironmentRuntimeStatus {
            environment_id: env.id.clone(),
            status: RuntimeStatus::Unknown,
            pid: Some(pid),
            cdp_port: Some(runtime_port),
            message: Some(
                "Process exists, but Camoufox control bridge is not available yet".to_string(),
            ),
        };
    }

    if cdp_client::ping(runtime_port).await {
        EnvironmentRuntimeStatus {
            environment_id: env.id.clone(),
            status: RuntimeStatus::Running,
            pid: Some(pid),
            cdp_port: Some(runtime_port),
            message: None,
        }
    } else {
        EnvironmentRuntimeStatus {
            environment_id: env.id.clone(),
            status: RuntimeStatus::Unknown,
            pid: Some(pid),
            cdp_port: Some(runtime_port),
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
    fn locale_profile_tracks_country_and_timezone() {
        let china = locale_profile_for(Some("CN"), Some("America/New_York"));
        let london = locale_profile_for(None, Some("Europe/London"));

        assert_eq!(china.locale, "zh-CN");
        assert_eq!(china.accept_languages, "zh-CN,zh");
        assert_eq!(london.locale, "en-GB");
        assert_eq!(london.accept_languages, "en-GB,en");
    }

    #[test]
    fn camoufox_python_path_prefers_environment_then_settings() {
        assert_eq!(
            camoufox_python_override(Some("/env/python"), Some("/settings/python")),
            Some("/env/python")
        );
        assert_eq!(
            camoufox_python_override(Some("  "), Some("/settings/python")),
            Some("/settings/python")
        );
        assert_eq!(camoufox_python_override(None, Some("  ")), None);
    }

    #[tokio::test]
    #[ignore = "launches the local Chrome/Chromium browser"]
    async fn chrome_runtime_watcher_keeps_timezone_across_navigation_and_reconnect() -> AppResult<()>
    {
        let data_dir = std::env::temp_dir().join(format!(
            "orbit-timezone-watcher-smoke-{}",
            uuid::Uuid::new_v4()
        ));
        let state = AppState::initialize(data_dir.clone())?;
        let env = environment_repo::save(
            state.db(),
            SaveEnvironmentInput {
                id: Some("env_timezone_watcher_smoke".to_string()),
                name: "Timezone Watcher Smoke".to_string(),
                group_id: None,
                tags: Vec::new(),
                notes: None,
                browser_kind: BrowserKind::Chrome,
                chrome_path_override: None,
                proxy_config: ProxyConfig::default(),
                locale: "en-US".to_string(),
                timezone_id: Some("America/New_York".to_string()),
                geolocation_latitude: None,
                geolocation_longitude: None,
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

        let result = async {
            let runtime = start_environment_inner(&state, env.id.clone()).await?;
            let cdp_port = runtime
                .cdp_port
                .ok_or_else(|| AppError::new("cdp_missing", "CDP port was not assigned"))?;
            timezone_controller::stop_watcher(cdp_port);
            apply_and_watch_runtime(
                cdp_port,
                RuntimeFingerprint {
                    locale: "en-US".to_string(),
                    locale_override: Some("en-US".to_string()),
                    accept_languages: None,
                    timezone_id: Some("America/New_York".to_string()),
                    geolocation: None,
                },
            )
            .await;

            {
                let mut page = cdp_client::CdpPage::connect(cdp_port, None).await?;
                let timezone = page
                    .evaluate("Intl.DateTimeFormat().resolvedOptions().timeZone")
                    .await?;
                assert_eq!(timezone.as_str(), Some("America/New_York"));
                let locale = page
                    .evaluate("Intl.DateTimeFormat().resolvedOptions().locale")
                    .await?;
                assert_eq!(locale.as_str(), Some("en-US"));
                let patch_marker = page
                    .evaluate("typeof globalThis.__orbitLocaleMaskInstalled")
                    .await?;
                assert_eq!(patch_marker.as_str(), Some("undefined"));

                page.goto(
                    "data:text/html,<title>Orbit%20Timezone%20Smoke</title>",
                    Duration::from_secs(5),
                )
                .await?;
                let timezone = page
                    .evaluate("Intl.DateTimeFormat().resolvedOptions().timeZone")
                    .await?;
                assert_eq!(timezone.as_str(), Some("America/New_York"));
            }

            tokio::time::sleep(Duration::from_millis(800)).await;
            let mut reconnected = cdp_client::CdpPage::connect(cdp_port, None).await?;
            let timezone = reconnected
                .evaluate("Intl.DateTimeFormat().resolvedOptions().timeZone")
                .await?;
            assert_eq!(timezone.as_str(), Some("America/New_York"));
            Ok(())
        }
        .await;

        let _ = stop_environment_inner(&state, &env.id);
        let _ = std::fs::remove_dir_all(data_dir);
        result
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
