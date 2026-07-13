mod app_state;
mod automation;
mod browser;
mod commands;
mod domain;
mod errors;
mod mcp;
mod queue;
mod storage;

use app_state::AppState;
use errors::{AppError, AppResult};
use std::path::PathBuf;
use tauri::{Emitter, Manager};

pub fn resolve_app_data_dir() -> AppResult<PathBuf> {
    if let Ok(path) = std::env::var("ORBIT_BROWSER_DATA_DIR") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    dirs::data_dir()
        .map(|dir| dir.join("com.orbit.browser"))
        .ok_or_else(|| AppError::new("data_dir_unavailable", "Unable to resolve app data dir"))
}

pub fn run_mcp() -> AppResult<()> {
    let state = AppState::initialize(resolve_app_data_dir()?)?;
    mcp::run_stdio_server(state)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "orbit_browser=info,tauri=warn".into()),
        )
        .init();

    tauri::Builder::default()
        .setup(|app| {
            let data_dir = resolve_app_data_dir()?;
            let state = AppState::initialize(data_dir)?;
            let resume_state = state.clone();
            app.manage(state);
            let app_handle = app.handle().clone();
            if let Ok(count) =
                commands::tasks::resume_queued_batches(app_handle.clone(), resume_state)
            {
                if count > 0 {
                    let _ = app_handle.emit(
                        "diagnostic_warning",
                        format!("Recovered {count} unfinished queue batches"),
                    );
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::settings::detect_chrome,
            commands::settings::validate_chrome_path,
            commands::settings::detect_camoufox,
            commands::settings::validate_camoufox_python_path,
            commands::settings::install_camoufox,
            commands::settings::open_data_dir,
            commands::environments::list_environments,
            commands::environments::save_environment,
            commands::environments::delete_environment,
            commands::environments::duplicate_environment,
            commands::environments::start_environment,
            commands::environments::stop_environment,
            commands::environments::restart_environment,
            commands::environments::get_environment_statuses,
            commands::environments::validate_environment,
            commands::environments::test_environment_proxy,
            commands::environments::open_environment_profile_dir,
            commands::tasks::list_tasks,
            commands::tasks::save_task,
            commands::tasks::delete_task,
            commands::tasks::validate_task_script,
            commands::tasks::run_task,
            commands::tasks::cancel_run,
            commands::tasks::cancel_batch,
            commands::tasks::retry_run,
            commands::runs::list_runs,
            commands::runs::get_run_logs,
            commands::runs::list_run_artifacts,
            commands::runs::read_run_artifact,
            commands::runs::delete_run,
            commands::runs::delete_runs,
            commands::runs::open_run_artifact,
            commands::runs::open_run_artifacts_dir,
            commands::diagnostics::get_diagnostics,
            commands::diagnostics::cleanup_stale_sessions,
            commands::diagnostics::cleanup_temp_files,
            commands::agent::agent_browser_action,
            commands::agent::list_agent_histories,
            commands::agent::get_agent_history,
            commands::agent::save_agent_history,
            commands::agent::delete_agent_history,
            commands::agent::save_agent_artifact,
            commands::agent::read_agent_artifact,
            commands::agent::agent_start_browser_recording,
            commands::agent::agent_stop_browser_recording,
            commands::agent::agent_get_browser_recording,
            commands::agent::agent_clear_browser_recording,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run orbit browser");
}
